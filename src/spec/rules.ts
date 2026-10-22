import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  Manifest,
  TaskSpecFrontmatter,
  TaskId,
  type Diagnostic,
  type Settings,
} from "../contracts/index.js";
import { isSafePath, matchGlob, redactSecrets } from "../util/index.js";
import type { ParsedPlan, ParsedTaskSpec } from "./parser.js";
import type { LintOptions } from "./linter.js";
import { typecheckContracts } from "./typecheck.js";
import { SHELL_BUILTINS, verifyBinaryOf } from "./verify-command.js";

export interface RuleContext {
  plan: ParsedPlan;
  repoRoot: string;
  settings: Settings;
  options: LintOptions;
}

export type LintRule = (
  ctx: RuleContext
) => Promise<Diagnostic[]> | Diagnostic[];

function collectRepoFiles(repoRoot: string): string[] {
  const result: string[] = [];
  const defaultExcludes = new Set([".git", ".substrate", "node_modules"]);

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (defaultExcludes.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        result.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
      }
    }
  }

  walk(repoRoot);
  return result;
}

function patternMatchesAny(pattern: string, repoRoot: string, allFiles?: string[]): boolean {
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
    return fs.existsSync(path.resolve(repoRoot, pattern));
  }
  const files = allFiles ?? collectRepoFiles(repoRoot);
  return files.some((f) => matchGlob(pattern, f));
}

function getTransitiveDeps(
  taskId: TaskId,
  specs: Map<TaskId, ParsedTaskSpec>,
  visited = new Set<TaskId>()
): Set<TaskId> {
  const result = new Set<TaskId>();
  const spec = specs.get(taskId);
  if (!spec) return result;
  for (const dep of spec.frontmatter.depends_on ?? []) {
    if (!visited.has(dep)) {
      visited.add(dep);
      result.add(dep);
      const sub = getTransitiveDeps(dep, specs, visited);
      for (const s of sub) result.add(s);
    }
  }
  return result;
}

function isTestPath(filePath: string): boolean {
  return (
    filePath.startsWith("test/") ||
    filePath.startsWith("tests/") ||
    /\.(test|spec)\.[a-zA-Z0-9]+$/.test(filePath)
  );
}

/**
 * Strips the shell punctuation glued to a word of a verify command: a leading
 * parenthesis or quote, a trailing `;`, `&`, `|`, `)` or quote. `test/a.test.js;` names
 * `test/a.test.js`.
 */
function cleanShellWord(tok: string): string {
  return tok.replace(/^[('"`]+/, "").replace(/[)'"`;&|]+$/, "");
}

/** A word the shell expands with a glob (`*`, `?` or a bracket class). */
function isGlobPattern(p: string): boolean {
  return /[*?[]/.test(p);
}

function extractTestPaths(cmdRun: string): string[] {
  const tokens = cmdRun.trim().split(/\s+/);
  const paths: string[] = [];
  for (const tok of tokens) {
    const clean = cleanShellWord(tok);
    if ((clean.startsWith("test/") || clean.startsWith("tests/")) && clean.length > 5) {
      paths.push(clean);
    } else if (/\.(test|spec)\.[a-zA-Z0-9]+$/.test(clean)) {
      paths.push(clean);
    }
  }
  return paths;
}

function isBinaryResolvable(bin: string, repoRoot: string): boolean {
  if (!bin) return false;
  if (bin.includes("/")) {
    return fs.existsSync(path.resolve(repoRoot, bin));
  }
  const localBin = path.join(repoRoot, "node_modules", ".bin", bin);
  if (fs.existsSync(localBin)) return true;

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, bin))) return true;
    } catch {}
  }

  return SHELL_BUILTINS.has(bin);
}

async function runCommandQuick(
  run: string,
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let timer: NodeJS.Timeout | undefined;
    try {
      child = spawn("/bin/sh", ["-c", run], {
        cwd,
        detached: true,
        stdio: "ignore",
      });
    } catch {
      return resolve({ exitCode: 1 });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        resolve({ exitCode: null });
      }, timeoutMs);
    }

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code });
    });
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 1 });
    });
  });
}

// L001: Schema validation
export const ruleL001: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  const manifestRes = Manifest.safeParse(ctx.plan.manifest);
  if (!manifestRes.success) {
    for (const issue of manifestRes.error.issues) {
      diags.push({
        code: "L001",
        severity: "error",
        message: `Manifest schema validation failed at ${issue.path.join(".")}: ${issue.message}`,
        path: ctx.plan.manifestPath,
      });
    }
  }

  for (const [taskId, spec] of ctx.plan.specs) {
    const specRes = TaskSpecFrontmatter.safeParse(spec.frontmatter);
    if (!specRes.success) {
      for (const issue of specRes.error.issues) {
        diags.push({
          code: "L001",
          severity: "error",
          task: taskId,
          message: `Task spec schema validation failed for ${taskId} at ${issue.path.join(".")}: ${issue.message}`,
          path: spec.filePath,
        });
      }
    }
  }

  return diags;
};

// L002: Task ID format and uniqueness
export const ruleL002: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const taskIdRegex = /^[A-Z][A-Za-z0-9_-]{0,31}$/;
  const seen = new Set<string>();

  for (const task of ctx.plan.manifest?.tasks ?? []) {
    if (!taskIdRegex.test(task.id)) {
      diags.push({
        code: "L002",
        severity: "error",
        task: task.id,
        message: `Task ID '${task.id}' does not match regex /^[A-Z][A-Za-z0-9_-]{0,31}$/`,
      });
    }
    if (seen.has(task.id)) {
      diags.push({
        code: "L002",
        severity: "error",
        task: task.id,
        message: `Duplicate task ID '${task.id}' in manifest`,
      });
    }
    seen.add(task.id);
  }

  for (const [id, spec] of ctx.plan.specs) {
    if (!taskIdRegex.test(spec.frontmatter?.id ?? id)) {
      if (!diags.some((d) => d.task === id && d.code === "L002")) {
        diags.push({
          code: "L002",
          severity: "error",
          task: id,
          message: `Task ID '${id}' does not match regex /^[A-Z][A-Za-z0-9_-]{0,31}$/`,
        });
      }
    }
  }

  return diags;
};

// L003: a declared spec file that is missing on disk is a blocker (the task cannot be read). An orphan
// spec file under tasks/ is a warning: no task reads it, so scheduling is unaffected.
export const ruleL003: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const declaredSpecs = new Set<string>();

  for (const task of ctx.plan.manifest?.tasks ?? []) {
    declaredSpecs.add(path.normalize(task.spec));
    const fullSpecPath = path.resolve(ctx.repoRoot, task.spec);
    if (!fs.existsSync(fullSpecPath)) {
      diags.push({
        code: "L003",
        severity: "error",
        task: task.id,
        path: task.spec,
        message: `Spec file for task ${task.id} does not exist on disk: ${task.spec}`,
      });
    }
  }

  const tasksDir = path.resolve(ctx.repoRoot, "tasks");
  if (fs.existsSync(tasksDir)) {
    const scanDir = (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const rel = path.normalize(path.relative(ctx.repoRoot, full));
          if (!declaredSpecs.has(rel)) {
            diags.push({
              code: "L003",
              severity: "warn",
              path: rel,
              message: `Orphan spec file found in tasks directory: ${rel}`,
            });
          }
        }
      }
    };
    scanDir(tasksDir);
  }

  return diags;
};

// L004: Unknown task dependency
export const ruleL004: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const validTaskIds = new Set((ctx.plan.manifest?.tasks ?? []).map((t) => t.id));

  for (const [taskId, spec] of ctx.plan.specs) {
    for (const dep of spec.frontmatter?.depends_on ?? []) {
      if (!validTaskIds.has(dep)) {
        diags.push({
          code: "L004",
          severity: "error",
          task: taskId,
          message: `Task ${taskId} depends on unknown task ID '${dep}'`,
        });
      }
    }
  }

  return diags;
};

// L005: DAG cycle detection
export const ruleL005: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const allTasks = new Set<TaskId>();
  for (const task of ctx.plan.manifest?.tasks ?? []) allTasks.add(task.id);
  for (const id of ctx.plan.specs.keys()) allTasks.add(id);

  const adj = new Map<TaskId, TaskId[]>();
  for (const id of allTasks) {
    const spec = ctx.plan.specs.get(id);
    adj.set(id, spec?.frontmatter?.depends_on ?? []);
  }

  const state = new Map<TaskId, number>(); // 0: unvisited, 1: visiting, 2: visited
  const parent = new Map<TaskId, TaskId | null>();
  const reportedCycles = new Set<string>();

  function dfs(u: TaskId, currentPath: TaskId[]) {
    state.set(u, 1);
    currentPath.push(u);

    for (const v of adj.get(u) ?? []) {
      if (v === u) {
        const cycleKey = `${u}->${u}`;
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          diags.push({
            code: "L005",
            severity: "error",
            task: u,
            message: `Dependency cycle detected involving task ${u} (self-dependency: ${u} -> ${u})`,
          });
        }
      } else if (state.get(v) === 1) {
        const cycleStartIdx = currentPath.indexOf(v);
        const cycle = currentPath.slice(cycleStartIdx).concat(v);
        const cycleKey = [...cycle].sort().join(",");
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          diags.push({
            code: "L005",
            severity: "error",
            task: u,
            message: `Directed cycle detected in task dependencies: ${cycle.join(" -> ")}`,
          });
        }
      } else if (!state.has(v) || state.get(v) === 0) {
        parent.set(v, u);
        dfs(v, currentPath);
      }
    }

    currentPath.pop();
    state.set(u, 2);
  }

  for (const id of allTasks) {
    if (!state.has(id) || state.get(id) === 0) {
      dfs(id, []);
    }
  }

  return diags;
};

// L006: Path safety validation. A contract file outside the repository is a blocker: the stub commit adds
// every contract file to the run branch's index, and git refuses such a path. Every other unsafe path is a
// warning: the engine's scope check (a change outside the write set is dropped at merge) and the verify
// commands decide what a task may touch.
export const ruleL006: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  const check = (p: string | undefined, severity: "error" | "warn", task?: TaskId) => {
    if (typeof p !== "string" || !p) return;
    if (!isSafePath(ctx.repoRoot, p)) {
      diags.push({
        code: "L006",
        severity,
        task,
        path: p,
        message: `Path escapes repository root or is unsafe: ${p}`,
      });
    }
  };

  for (const f of ctx.plan.manifest?.contracts?.files ?? []) check(f, "error");
  for (const cmd of ctx.plan.manifest?.contracts?.typecheck ?? []) check(cmd.cwd, "warn");
  for (const cmd of ctx.plan.manifest?.setup ?? []) check(cmd.cwd, "warn");
  for (const cmd of ctx.plan.manifest?.integration_verify ?? []) check(cmd.cwd, "warn");

  for (const [id, spec] of ctx.plan.specs) {
    for (const p of spec.frontmatter?.read ?? []) check(p, "warn", id);
    for (const p of spec.frontmatter?.write ?? []) check(p, "warn", id);
    for (const p of spec.frontmatter?.create ?? []) check(p, "warn", id);
    for (const p of spec.frontmatter?.protected ?? []) check(p, "warn", id);
    for (const cmd of spec.frontmatter?.verify ?? []) check(cmd.cwd, "warn", id);
  }

  return diags;
};

// L007: Spec.write pattern matches existing files
export const ruleL007: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const allFiles = collectRepoFiles(ctx.repoRoot);

  for (const [id, spec] of ctx.plan.specs) {
    for (const pat of spec.frontmatter?.write ?? []) {
      if (!patternMatchesAny(pat, ctx.repoRoot, allFiles)) {
        diags.push({
          code: "L007",
          severity: "warn",
          task: id,
          path: pat,
          message: `Write pattern '${pat}' matches no existing files at base (use 'create' for new files)`,
        });
      }
    }
  }

  return diags;
};

// L008: Overlapping write/create in concurrent DAG layer tasks (warn)
export const ruleL008: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  // Compute layers
  const layers = new Map<TaskId, number>();
  const visited = new Set<TaskId>();

  function getLayer(id: TaskId, stack = new Set<TaskId>()): number {
    if (stack.has(id)) return 0; // cycle
    if (layers.has(id)) return layers.get(id)!;
    stack.add(id);
    const spec = ctx.plan.specs.get(id);
    const deps = spec?.frontmatter?.depends_on ?? [];
    let maxDep = -1;
    for (const dep of deps) {
      maxDep = Math.max(maxDep, getLayer(dep, stack));
    }
    stack.delete(id);
    const layer = maxDep + 1;
    layers.set(id, layer);
    return layer;
  }

  for (const id of ctx.plan.specs.keys()) {
    getLayer(id);
  }

  const byLayer = new Map<number, TaskId[]>();
  for (const [id, layer] of layers) {
    const list = byLayer.get(layer) ?? [];
    list.push(id);
    byLayer.set(layer, list);
  }

  for (const [layer, taskIds] of byLayer) {
    if (taskIds.length < 2) continue;
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        const t1 = taskIds[i];
        const t2 = taskIds[j];
        const s1 = ctx.plan.specs.get(t1);
        const s2 = ctx.plan.specs.get(t2);
        if (!s1 || !s2) continue;

        const targets1 = [...(s1.frontmatter?.write ?? []), ...(s1.frontmatter?.create ?? [])];
        const targets2 = [...(s2.frontmatter?.write ?? []), ...(s2.frontmatter?.create ?? [])];

        for (const p1 of targets1) {
          for (const p2 of targets2) {
            if (p1 === p2 || matchGlob(p1, p2) || matchGlob(p2, p1)) {
              diags.push({
                code: "L008",
                severity: "warn",
                task: t1,
                path: p1,
                message: `Tasks ${t1} and ${t2} ready at the same DAG layer ${layer} have overlapping targets '${p1}'`,
              });
              break;
            }
          }
        }
      }
    }
  }

  return diags;
};

// L009: Task write/create intersects a path another task protects.
// A task that is a transitive dependency (ancestor) of the protecting task runs
// before it, so it may create or write the path whatever its class. The
// protecting task itself and its descendants may not modify the path.
export const ruleL009: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  for (const [idA, specA] of ctx.plan.specs) {
    const targetsA = [...(specA.frontmatter?.write ?? []), ...(specA.frontmatter?.create ?? [])];
    const isTestsClass = specA.frontmatter?.class === "tests";

    for (const [idB, specB] of ctx.plan.specs) {
      const isSelf = idA === idB;
      const ancestorsOfB = getTransitiveDeps(idB, ctx.plan.specs);
      if (!isSelf && ancestorsOfB.has(idA)) continue;

      for (const prot of specB.frontmatter?.protected ?? []) {
        for (const target of targetsA) {
          if (target === prot || matchGlob(prot, target) || matchGlob(target, prot)) {
            if (isSelf) {
              diags.push({
                code: "L009",
                severity: "warn",
                task: idA,
                path: target,
                message: `Task ${idA} modifies path '${target}' that it protects itself; remove '${target}' from its write/create lists or from its protected list`,
              });
              continue;
            }
            const authoringTests = isTestsClass && isTestPath(target);
            if (!authoringTests) {
              diags.push({
                code: "L009",
                severity: "warn",
                task: idA,
                path: target,
                message: `Task ${idA} modifies path '${target}' protected by task ${idB}; make ${idA} a dependency of ${idB} (depends_on) or remove '${target}' from ${idB}'s protected list`,
              });
            }
          }
        }
      }
    }
  }

  return diags;
};

// L010: Verify command is empty or missing
export const ruleL010: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  for (const [id, spec] of ctx.plan.specs) {
    if (!spec.frontmatter?.verify || spec.frontmatter.verify.length === 0) {
      diags.push({
        code: "L010",
        severity: "warn",
        task: id,
        message: `Task ${id} has empty or missing verify command`,
      });
    }
  }

  return diags;
};

/** True when the plan's setup commands or its created or written paths name the binary as a whole word. */
function planCreates(bin: string, plan: ParsedPlan): boolean {
  const word = new RegExp(`(^|[^A-Za-z0-9_.-])${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_.-])`);
  const setup = (plan.manifest.setup ?? []).map((c) => c.run);
  if (setup.some((run) => word.test(run))) return true;
  for (const spec of plan.specs.values()) {
    for (const p of [...(spec.frontmatter?.create ?? []), ...(spec.frontmatter?.write ?? [])]) {
      if (word.test(p)) return true;
    }
  }
  return false;
}

// L011: Verify binary cannot be resolved or cwd does not exist
export const ruleL011: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  for (const [id, spec] of ctx.plan.specs) {
    for (const cmd of spec.frontmatter?.verify ?? []) {
      // R11.1 (known issue 24b): the binary is the first command word, after assignments; a line with no
      // plain command word (a subshell, a substitution first) is not checked, and neither is a binary the
      // plan itself creates (setup or a written file).
      const bin = verifyBinaryOf(cmd.run);
      if (bin !== undefined && !isBinaryResolvable(bin, ctx.repoRoot) && !planCreates(bin, ctx.plan)) {
        diags.push({
          code: "L011",
          severity: "warn",
          task: id,
          message: `Verify binary '${bin}' cannot be resolved on PATH: ${cmd.run}`,
        });
      }

      if (cmd.cwd) {
        const fullCwd = path.resolve(ctx.repoRoot, cmd.cwd);
        try {
          if (!fs.existsSync(fullCwd) || !fs.statSync(fullCwd).isDirectory()) {
            diags.push({
              code: "L011",
              severity: "warn",
              task: id,
              path: cmd.cwd,
              message: `verify.cwd directory '${cmd.cwd}' does not exist`,
            });
          }
        } catch {
          diags.push({
            code: "L011",
            severity: "warn",
            task: id,
            path: cmd.cwd,
            message: `verify.cwd directory '${cmd.cwd}' does not exist`,
          });
        }
      }
    }
  }

  return diags;
};

// L012: Verify references a test path that exists at base or is provided by
// the same task (create/write) or by a transitive dependency (create/write).
export const ruleL012: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  for (const [id, spec] of ctx.plan.specs) {
    const earlierDeps = getTransitiveDeps(id, ctx.plan.specs);
    const provided = new Set<string>();
    const providers = [spec, ...[...earlierDeps].map((depId) => ctx.plan.specs.get(depId))];
    for (const provider of providers) {
      for (const c of [...(provider?.frontmatter?.create ?? []), ...(provider?.frontmatter?.write ?? [])]) {
        provided.add(c);
      }
    }

    for (const cmd of spec.frontmatter?.verify ?? []) {
      const testPaths = extractTestPaths(cmd.run);
      for (const tPath of testPaths) {
        // The shell expands a glob when the command runs, and a glob that matches nothing
        // then fails inside the verify command itself. A pattern is not a missing literal
        // path, so it is not reported here.
        if (isGlobPattern(tPath)) continue;
        const full = path.resolve(ctx.repoRoot, tPath);
        if (!fs.existsSync(full)) {
          let isProvided = false;
          for (const c of provided) {
            if (c === tPath || matchGlob(c, tPath)) {
              isProvided = true;
              break;
            }
          }
          if (!isProvided) {
            diags.push({
              code: "L012",
              severity: "warn",
              task: id,
              path: tPath,
              message: `Verify command references test path '${tPath}' that nothing provides; create it in this task or a dependency, or fix the path`,
            });
          }
        }
      }
    }
  }

  return diags;
};

// L013: Placeholder tokens outside code fences in Interface or Behavior
export const ruleL013: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const placeholderRegex = /\b(TODO|FIXME|TBD)\b|\.\.\.|<placeholder>/i;

  for (const [id, spec] of ctx.plan.specs) {
    for (const secName of ["Interface", "Behavior"]) {
      const text = spec.sections.get(secName);
      if (text) {
        const stripped = text.replace(/```[\s\S]*?```/g, "");
        if (placeholderRegex.test(stripped)) {
          diags.push({
            code: "L013",
            severity: "warn",
            task: id,
            message: `Placeholder token found in ${secName} section outside code fences`,
          });
        }
      }
    }
  }

  return diags;
};

// L014: Required sections missing or empty
export const ruleL014: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const required = [
    "Objective",
    "Interface",
    "Behavior",
    "Invariants",
    "Edge cases",
    "Guardrails",
    "Out of scope",
  ];

  for (const [id, spec] of ctx.plan.specs) {
    for (const req of required) {
      if (!spec.sections.has(req) || spec.sections.get(req)!.trim().length === 0) {
        diags.push({
          code: "L014",
          severity: "warn",
          task: id,
          message: `Task ${id} is missing required section '${req}' or section is empty`,
        });
      }
    }
  }

  return diags;
};

// L015 (a class must be routable) is retired (R7.7). Every class resolves: routing.<class>,
// the worker profile slot, the request's named worker or the built-in fallback route
// (roles/router.ts resolveTaskRoute never throws), so no class can be unrouted.

// L016: Task budget above the per-task cap is a warning. It fires only when the caller set a per-task
// cap (budgets.task.max_usd). The spec's budget is advisory: an estimate, never a limit, so this is a
// warning and no task is ended by it. No cap set (the default): silent.
export const ruleL016: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const taskCap = ctx.settings.budgets?.task?.max_usd;
  if (taskCap === undefined) return diags;

  for (const [id, spec] of ctx.plan.specs) {
    const specUsd = spec.frontmatter?.budget?.max_usd;
    if (specUsd !== undefined && specUsd > taskCap) {
      diags.push({
        code: "L016",
        severity: "warn",
        task: id,
        message: `Task ${id} budget estimate ($${specUsd}) exceeds the per-task cap ($${taskCap}); the cap is what ends it`,
      });
    }
  }

  return diags;
};

// L017: Aggregate files matching spec.read exceed budget
export const ruleL017: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const allFiles = collectRepoFiles(ctx.repoRoot);
  const maxFiles = ctx.options.contextBudgetFiles ?? 50;
  const maxBytes = ctx.options.contextBudgetBytes ?? 500 * 1024;

  for (const [id, spec] of ctx.plan.specs) {
    const matchedFiles = new Set<string>();
    for (const pat of spec.frontmatter?.read ?? []) {
      for (const f of allFiles) {
        if (f === pat || matchGlob(pat, f)) {
          matchedFiles.add(f);
        }
      }
    }

    let totalBytes = 0;
    for (const f of matchedFiles) {
      try {
        const st = fs.statSync(path.resolve(ctx.repoRoot, f));
        totalBytes += st.size;
      } catch {}
    }

    if (matchedFiles.size > maxFiles || totalBytes > maxBytes) {
      diags.push({
        code: "L017",
        severity: "warn",
        task: id,
        message: `Task ${id} read set exceeds budget: ${matchedFiles.size} files (cap ${maxFiles}), ${totalBytes} bytes (cap ${maxBytes})`,
      });
    }
  }

  return diags;
};

// L018: Contract typecheck execution. It runs in the run directory that holds the manifest:
// the planner wrote and checked the stubs there. The repository root is not used because
// safeLoadPlan writes placeholder files there (`export {};`), and a placeholder package.json
// is not valid JSON, so Node fails with ERR_INVALID_PACKAGE_CONFIG (R7.7).
// A type error and a checker that cannot run are both warnings (the plan still runs), and neither costs a
// planner retry: the stubs are a hint to the workers, and the task verify commands are the real gate.
export const ruleL018: LintRule = async (ctx) => {
  const diags: Diagnostic[] = [];
  if (!ctx.plan.manifest?.contracts) return diags;

  const runDir = path.dirname(path.resolve(ctx.repoRoot, ctx.plan.manifestPath));
  try {
    const res = await typecheckContracts(runDir, ctx.plan.manifest.contracts);
    for (const d of res.diagnostics) {
      if (d.code === "L018") diags.push({ ...d, severity: "warn" });
    }
  } catch (err: any) {
    diags.push({
      code: "L018",
      severity: "warn",
      message: `Contract typecheck could not run: ${err?.message ?? String(err)}`,
    });
  }
  return diags;
};

// L019: Missing contract files or undeclared contracts in Interface
export const ruleL019: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const declaredFiles = new Set(ctx.plan.manifest?.contracts?.files ?? []);

  for (const f of declaredFiles) {
    const full = path.resolve(ctx.repoRoot, f);
    if (!fs.existsSync(full)) {
      diags.push({
        code: "L019",
        severity: "warn",
        path: f,
        message: `Contract file does not exist on disk: ${f}`,
      });
    }
  }

  for (const [id, spec] of ctx.plan.specs) {
    const interfaceText = spec.sections.get("Interface") ?? "";
    const matches = interfaceText.match(/src\/contracts\/[a-zA-Z0-9_.-]+/g) ?? [];
    for (const m of matches) {
      const full = path.resolve(ctx.repoRoot, m);
      if (!declaredFiles.has(m) || !fs.existsSync(full)) {
        diags.push({
          code: "L019",
          severity: "warn",
          task: id,
          path: m,
          message: `Interface references undeclared or non-existent contract file: ${m}`,
        });
      }
    }
  }

  return diags;
};

// L020: Code fence contains implementation bodies
export const ruleL020: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const implRegex = /\b(for|while)\s*\(|\breturn\s+\S|\b(let|var)\s+\w+\s*=|function\s+\w+\s*\(.*?\)\s*\{/;

  for (const [id, spec] of ctx.plan.specs) {
    for (const cb of spec.codeBlocks ?? []) {
      if (implRegex.test(cb.code)) {
        diags.push({
          code: "L020",
          severity: "warn",
          task: id,
          message: `Code fence in task ${id} appears to contain implementation bodies rather than declarations`,
        });
        break;
      }
    }
  }

  return diags;
};

// L021: manifest.integration_verify is empty (warn)
export const ruleL021: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  if (!ctx.plan.manifest?.integration_verify || ctx.plan.manifest.integration_verify.length === 0) {
    diags.push({
      code: "L021",
      severity: "warn",
      message: "manifest.integration_verify is empty or missing",
    });
  }
  return diags;
};

// L022: Estimated run cost exceeds approval threshold (gate)
export const ruleL022: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const threshold = ctx.settings.budgets?.approval_threshold_usd;
  if (threshold === undefined) return diags;

  let totalUsd = 0;
  for (const spec of ctx.plan.specs.values()) {
    totalUsd += spec.frontmatter?.budget?.max_usd ?? 0;
  }

  if (totalUsd > threshold) {
    diags.push({
      code: "L022",
      severity: "gate",
      message: `Estimated total run cost ($${totalUsd.toFixed(2)}) exceeds approval threshold ($${threshold.toFixed(2)})`,
    });
  }

  return diags;
};

// L023: Verify passes at base ref (red-check)
// L023 is off unless `lint.red_check` is true (it runs every verify command at the base ref, which costs time).
// When on, it is always a warning: a verify that passes before the change is a guess about the base, and the
// engine's own verify decides each task.
export const ruleL023: LintRule = async (ctx) => {
  const diags: Diagnostic[] = [];
  if (!ctx.settings.lint?.red_check) return diags;

  for (const [id, spec] of ctx.plan.specs) {
    for (const cmd of spec.frontmatter?.verify ?? []) {
      const cwd = cmd.cwd ? path.resolve(ctx.repoRoot, cmd.cwd) : ctx.repoRoot;
      const res = await runCommandQuick(cmd.run, cwd, (cmd.timeout_s ?? 10) * 1000);
      if (res.exitCode === 0) {
        diags.push({
          code: "L023",
          severity: "warn",
          task: id,
          message: `Verify command '${cmd.run}' passed at base ref before modifications (expected red/failing)`,
        });
      }
    }
  }

  return diags;
};

// L024: Class tests modifies non-test paths or non-tests modifies test paths (warn)
export const ruleL024: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];

  for (const [id, spec] of ctx.plan.specs) {
    const isTestsClass = spec.frontmatter?.class === "tests";
    const targets = [...(spec.frontmatter?.write ?? []), ...(spec.frontmatter?.create ?? [])];

    for (const target of targets) {
      const isTest = isTestPath(target);
      if (isTestsClass && !isTest) {
        diags.push({
          code: "L024",
          severity: "warn",
          task: id,
          path: target,
          message: `Task ${id} has class 'tests' but modifies non-test path '${target}'`,
        });
      } else if (!isTestsClass && isTest) {
        diags.push({
          code: "L024",
          severity: "warn",
          task: id,
          path: target,
          message: `Task ${id} has class '${spec.frontmatter?.class}' but modifies test path '${target}'`,
        });
      }
    }
  }

  return diags;
};

// L025: Manifest budget exceeds run cap (warn)
export const ruleL025: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const runCap = ctx.settings.budgets?.run?.max_usd;
  const manifestBudget = ctx.plan.manifest?.budget?.max_usd;

  if (runCap !== undefined && manifestBudget !== undefined && manifestBudget > runCap) {
    diags.push({
      code: "L025",
      severity: "warn",
      message: `Manifest budget ($${manifestBudget}) exceeds settings.budgets.run.max_usd ($${runCap})`,
    });
  }

  return diags;
};

// L026: Task count exceeds maxTasks (warn)
export const ruleL026: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const maxTasks = ctx.options.maxTasks ?? 40;
  const taskCount = ctx.plan.manifest?.tasks?.length ?? 0;

  if (taskCount > maxTasks) {
    diags.push({
      code: "L026",
      severity: "warn",
      message: `Total task count (${taskCount}) exceeds maximum limit (${maxTasks})`,
    });
  }

  return diags;
};

// L027: Protected path does not exist at base and not created earlier
export const ruleL027: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const allFiles = collectRepoFiles(ctx.repoRoot);

  for (const [id, spec] of ctx.plan.specs) {
    const earlierDeps = getTransitiveDeps(id, ctx.plan.specs);
    const createdEarlier = new Set<string>();
    for (const depId of earlierDeps) {
      const depSpec = ctx.plan.specs.get(depId);
      for (const c of depSpec?.frontmatter?.create ?? []) {
        createdEarlier.add(c);
      }
    }

    for (const prot of spec.frontmatter?.protected ?? []) {
      const existsAtBase = patternMatchesAny(prot, ctx.repoRoot, allFiles);
      if (!existsAtBase) {
        let createdByDep = false;
        for (const c of createdEarlier) {
          if (c === prot || matchGlob(c, prot)) {
            createdByDep = true;
            break;
          }
        }
        if (!createdByDep) {
          diags.push({
            code: "L027",
            severity: "warn",
            task: id,
            path: prot,
            message: `Protected path '${prot}' does not exist at base and is not created by an earlier dependency task`,
          });
        }
      }
    }
  }

  return diags;
};

// L028: A tests task lists more than about 10 test targets in Behavior (warn). Advisory only:
// the planner keeps the targets that carry risk and moves the rest to Out of scope.
export const ruleL028: LintRule = (ctx) => {
  const diags: Diagnostic[] = [];
  const maxTargets = 10;

  for (const [id, spec] of ctx.plan.specs) {
    if (spec.frontmatter?.class !== "tests") continue;
    const behavior = (spec.sections.get("Behavior") ?? "").replace(/```[\s\S]*?```/g, "");
    const count = behavior.split("\n").filter((line) => /^\s*\d+[.)]\s/.test(line)).length;
    if (count > maxTargets) {
      diags.push({
        code: "L028",
        severity: "warn",
        task: id,
        message: `Task ${id} lists ${count} test targets; keep the ones that carry risk (about 10 or fewer) and move the rest to Out of scope`,
      });
    }
  }

  return diags;
};

export const ALL_RULES: LintRule[] = [
  ruleL001,
  ruleL002,
  ruleL003,
  ruleL004,
  ruleL005,
  ruleL006,
  ruleL007,
  ruleL008,
  ruleL009,
  ruleL010,
  ruleL011,
  ruleL012,
  ruleL013,
  ruleL014,
  ruleL016,
  ruleL017,
  ruleL018,
  ruleL019,
  ruleL020,
  ruleL021,
  ruleL022,
  ruleL023,
  ruleL024,
  ruleL025,
  ruleL026,
  ruleL027,
  ruleL028,
];
