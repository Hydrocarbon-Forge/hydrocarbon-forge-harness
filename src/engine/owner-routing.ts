import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { TaskId, type VerifyResult } from "../contracts/index.js";
import { parseManifest, parseTaskSpec } from "../spec/index.js";
import { loadTemplate } from "../prompts/index.js";
import { render } from "../prompts/render.js";
import type { EngineState } from "./reducer.js";

// 2026-10-23 (owner, item 88): a failed check names files that another task owns. The replan does not change another
// task, so the engine routes the failure to its owner instead of escalating it to L2. A task whose owner has not merged
// waits for it (`defer`); a task whose owner has merged gets a fix task that owns exactly the failing files and runs
// after the owner (`fix`). Ownership is the manifest's per-task write and create sets. When ownership cannot be
// decided (no owner, several owners, a cycle, an owner that failed, or the routing cap), the ladder runs as before.

/** Routings one task may take. The cap stops a cycle of defer and fix routings from looping. */
export const MAX_OWNER_ROUTINGS_PER_TASK = 2;

const MANIFEST_FILE = "manifest.yaml";
const SPEC_FENCE = "---";
const FIX_TASK_VERIFY_TIMEOUT_S = 300;
const UNRESOLVED_OWNER_STATES = new Set(["BLOCKED", "ABANDONED", "FAILED"]);

export interface OwnershipTask {
  id: TaskId;
  spec: string;
  depends_on: TaskId[];
  write: string[];
  create: string[];
}

export interface OwnerRoute {
  kind: "defer" | "fix";
  owner: TaskId;
  /** The owned paths the failing output names, all of them owned by `owner`. */
  files: string[];
  /** The failing check commands, from the failed generation's verify output. */
  commands: string[];
  /** The failing output, clipped, for the fix task's spec. Data from the run, never an instruction. */
  excerpt: string;
}

/** The manifest's tasks with the ownership and dependencies its specs declare; undefined when it cannot be read. */
export function readOwnership(runDir: string): OwnershipTask[] | undefined {
  const manifestPath = path.join(runDir, MANIFEST_FILE);
  let manifest;
  try {
    manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
  } catch {
    return undefined;
  }

  const tasks: OwnershipTask[] = [];
  for (const entry of manifest.tasks) {
    try {
      const spec = parseTaskSpec(fs.readFileSync(path.resolve(runDir, entry.spec), "utf8"), entry.spec);
      tasks.push({
        id: entry.id,
        spec: entry.spec,
        depends_on: spec.frontmatter.depends_on ?? [],
        write: spec.frontmatter.write ?? [],
        create: spec.frontmatter.create ?? [],
      });
    } catch {
      return undefined;
    }
  }
  return tasks;
}

/** True when `path` appears in `text` as a whole path token; a directory entry (ends with "/") matches its prefix. */
export function mentionsPath(text: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = target.endsWith("/")
    ? `(?<![\\w./-])${escaped}`
    : `(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`;
  return new RegExp(pattern).test(text);
}

/** True when `from` reaches `target` by following depends_on (a path in the dependency graph). */
function dependsOnTransitively(tasks: OwnershipTask[], from: TaskId, target: TaskId): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<TaskId>();
  const stack: TaskId[] = [from];
  while (stack.length > 0) {
    const id = stack.pop() as TaskId;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) stack.push(dep);
  }
  return false;
}

function failingOutputs(verify: VerifyResult[]): VerifyResult[] {
  return verify.filter((v) => v.timed_out || v.exit_code !== 0);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Decides whether a failed task's failure belongs to another task's files, and how to route it. Returns undefined when
 * the failure is the task's own (its own files, or none named), when the owner cannot be decided, or when a routing
 * would be a cycle or exceeds the cap. Pure: it reads the run directory and the state, and changes nothing.
 */
export function decideOwnerRoute(input: {
  runDir: string;
  taskId: TaskId;
  state: EngineState;
  verify: VerifyResult[];
  /** Routings this task has already taken in the run. */
  routings: number;
}): OwnerRoute | undefined {
  if (input.routings >= MAX_OWNER_ROUTINGS_PER_TASK) return undefined;

  const failing = failingOutputs(input.verify);
  if (failing.length === 0) return undefined;

  const tasks = readOwnership(input.runDir);
  if (!tasks) return undefined;
  const me = tasks.find((t) => t.id === input.taskId);
  if (!me) return undefined;
  const myPaths = [...me.write, ...me.create];

  const texts = failing.map((v) => [v.cmd, v.stdout_tail, v.stderr_tail].join("\n"));
  // A failure that names one of the task's own files is its own failure, for the ladder.
  if (myPaths.some((owned) => texts.some((text) => mentionsPath(text, owned)))) return undefined;

  const owners = new Map<TaskId, Set<string>>();
  for (const other of tasks) {
    if (other.id === me.id) continue;
    for (const owned of [...other.write, ...other.create]) {
      if (texts.some((text) => mentionsPath(text, owned))) {
        const files = owners.get(other.id) ?? new Set<string>();
        files.add(owned);
        owners.set(other.id, files);
      }
    }
  }

  // Not owned by anyone else, or owned by several tasks: the ladder decides, as before.
  const only = owners.size === 1 ? [...owners.entries()][0] : undefined;
  if (!only) return undefined;
  const [owner, fileSet] = only;

  const ownerState = input.state.tasks[owner]?.state;
  if (ownerState === undefined || UNRESOLVED_OWNER_STATES.has(ownerState)) return undefined;
  if (dependsOnTransitively(tasks, owner, me.id)) return undefined;

  return {
    kind: ownerState === "MERGED" ? "fix" : "defer",
    owner,
    files: [...fileSet].sort(),
    commands: failing.map((v) => v.cmd),
    excerpt: clip(texts.join("\n---\n"), 2000),
  };
}

/** `---` fenced frontmatter and the body after it; undefined when the text has no closed frontmatter. */
function splitSpec(text: string): { frontmatter: Record<string, unknown>; body: string } | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== SPEC_FENCE) return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === SPEC_FENCE);
  if (end < 0) return undefined;
  const parsed = YAML.parse(lines.slice(1, end).join("\n"));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return { frontmatter: parsed as Record<string, unknown>, body: lines.slice(end + 1).join("\n") };
}

function joinSpec(frontmatter: Record<string, unknown>, body: string): string {
  return `${SPEC_FENCE}\n${YAML.stringify(frontmatter)}${SPEC_FENCE}\n${body}`;
}

export interface AppliedOwnerRoute {
  /** The new task the route created, for a `fix` route. */
  fixTaskId?: TaskId;
  /** Puts back every file the route wrote. */
  restore(): void;
}

/**
 * Writes the route into the run directory: the replanned task gains a dependency (on the owner for `defer`, on the new
 * fix task for `fix`), and a `fix` route adds the fix task to the manifest with its spec. Returns undefined, having
 * written nothing, when the route cannot be built (an id that is not a valid task id, a spec that cannot be read).
 */
export function applyOwnerRoute(
  runDir: string,
  taskId: TaskId,
  route: OwnerRoute,
  state: EngineState,
): AppliedOwnerRoute | undefined {
  const tasks = readOwnership(runDir);
  const me = tasks?.find((t) => t.id === taskId);
  if (!tasks || !me) return undefined;

  const manifestPath = path.join(runDir, MANIFEST_FILE);
  const mySpecPath = path.resolve(runDir, me.spec);
  const snapshots = new Map<string, string | undefined>();
  const remember = (file: string): void => {
    if (!snapshots.has(file)) snapshots.set(file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);
  };

  const mySpec = splitSpec(fs.readFileSync(mySpecPath, "utf8"));
  if (!mySpec) return undefined;

  let dependency: TaskId = route.owner;
  let fixTaskId: TaskId | undefined;
  let fixSpecText: string | undefined;
  let fixSpecPath: string | undefined;

  if (route.kind === "fix") {
    const taken = new Set<string>([...tasks.map((t) => t.id), ...Object.keys(state.tasks)]);
    let n = 1;
    while (taken.has(`${route.owner}-FIX${n}`)) n += 1;
    const candidate = `${route.owner}-FIX${n}`;
    if (!TaskId.safeParse(candidate).success) return undefined;
    fixTaskId = candidate as TaskId;
    dependency = fixTaskId;

    const ownerEntry = tasks.find((t) => t.id === route.owner);
    if (!ownerEntry) return undefined;
    const ownerSpec = splitSpec(fs.readFileSync(path.resolve(runDir, ownerEntry.spec), "utf8"));
    const frontmatter: Record<string, unknown> = {
      ...mySpec.frontmatter,
      id: fixTaskId,
      title: `Make ${route.files.join(", ")} pass the failing check`,
      class: ownerSpec?.frontmatter.class ?? mySpec.frontmatter.class ?? "feature",
      depends_on: [route.owner],
      write: route.files,
      create: [],
      protected: [],
      verify: route.commands.map((run) => ({ run, timeout_s: FIX_TASK_VERIFY_TIMEOUT_S })),
    };
    const body = render(loadTemplate("planner/owner-fix-spec.md"), {
      owner_id: route.owner,
      files: route.files.map((f) => `- ${f}`).join("\n"),
      failure_excerpt: route.excerpt,
    });
    fixSpecPath = path.join(runDir, "tasks", `${fixTaskId}.md`);
    fixSpecText = joinSpec(frontmatter, body);
  }

  const mine = { ...mySpec.frontmatter };
  const deps = Array.isArray(mine.depends_on) ? (mine.depends_on as string[]) : [];
  mine.depends_on = [...new Set([...deps, dependency])];

  try {
    remember(mySpecPath);
    remember(manifestPath);
    if (fixSpecPath) remember(fixSpecPath);

    if (fixTaskId && fixSpecPath && fixSpecText) {
      const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8")) as { tasks: Array<{ id: string; spec: string }> };
      manifest.tasks.push({ id: fixTaskId, spec: `tasks/${fixTaskId}.md` });
      fs.mkdirSync(path.dirname(fixSpecPath), { recursive: true });
      fs.writeFileSync(fixSpecPath, fixSpecText, "utf8");
      fs.writeFileSync(manifestPath, YAML.stringify(manifest), "utf8");
    }
    fs.writeFileSync(mySpecPath, joinSpec(mine, mySpec.body), "utf8");
  } catch {
    restoreSnapshots(snapshots);
    return undefined;
  }

  return {
    ...(fixTaskId ? { fixTaskId } : {}),
    restore: () => restoreSnapshots(snapshots),
  };
}

function restoreSnapshots(snapshots: Map<string, string | undefined>): void {
  for (const [file, content] of snapshots) {
    if (content === undefined) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content, "utf8");
  }
}
