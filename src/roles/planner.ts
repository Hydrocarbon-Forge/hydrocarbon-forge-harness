import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import type {
  Command,
  Diagnostic,
  EngineEvent,
  HarnessAdapter,
  Manifest,
  Route,
  RunId,
  Settings,
  SpawnRequest,
  TaskId,
  UsageRecord,
} from "../contracts/index.js";
import type { EventData, EventType } from "../contracts/events.js";
import {
  parseManifest,
  parseTaskSpec,
  lintPlan,
  typecheckContracts,
  detectEcosystem,
  generateRepoMap,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../spec/index.js";
import type { UsageTotals } from "../ledger/usage.js";
import { toDelta } from "../ledger/usage.js";
import { buildPlannerPrompt, buildCorrectionPrompt } from "./prompts/planner.js";

/**
 * The action's typed emit, handed to the planner so each backend usage event is
 * recorded as `usage.recorded {record, role: "planner"}` while the session runs.
 */
export type PlannerEmit = <T extends EventType>(
  type: T,
  data: EventData<T>
) => EngineEvent;

export interface PlannerRunOptions {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  request: string;
  settings: Settings;
  /** Adapter for the planner route's backend (R2.2). */
  adapter: HarnessAdapter;
  instructionFiles?: string[];
  skillsList?: Array<{ name: string; description: string }>;
  /** Planner route resolved by the plan action with `resolvePlannerRoute` (R2.9). */
  route?: Route;
  onEvent?: PlannerEmit;
}

export type PlannerOutcome =
  | {
      kind: "plan_ready";
      plan: ParsedPlan;
      usage: UsageRecord;
      commitSha: string;
      sessionId: string;
    }
  | {
      kind: "needs_input";
      questionsPath: string;
      sessionId: string;
      usage: UsageRecord;
    };

export class PlannerFailure extends Error {
  readonly reason: "format" | "session";
  readonly diagnostics: string[];

  constructor(reason: "format" | "session", message: string, diagnostics: string[] = []) {
    super(diagnostics.length > 0 ? `${message}\n${diagnostics.map((d) => `- ${d}`).join("\n")}` : message);
    this.name = "PlannerFailure";
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

const PLAN_READY = "PLAN READY";
const NEEDS_INPUT = "NEEDS INPUT";
const QUESTIONS_FILE = "QUESTIONS.md";
const MANIFEST_FILE = "manifest.yaml";
const ZERO_OID = "0000000000000000000000000000000000000000";

export const REQUIRED_HEADINGS = [
  "Objective",
  "Interface",
  "Behavior",
  "Invariants",
  "Edge cases",
  "Guardrails",
  "Out of scope",
];

const DENY_PERMISSIONS = [
  "git commit",
  "git push",
  "git checkout",
  "git reset",
  "subagents",
];

const INSTRUCTION_CANDIDATES = ["CLAUDE.md", "AGENTS.md", "SUBSTRATE.md"];

/** The last non-empty line of `final_text`, trimmed. */
export function finishLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== "") return line;
  }
  return "";
}

/** A path relative to the run directory, with no absolute or `..` segments. */
function isSafeRelativePath(relPath: string): boolean {
  if (path.isAbsolute(relPath) || relPath.startsWith("/") || relPath.startsWith("\\")) {
    return false;
  }
  return !relPath.split(/[/\\]/).includes("..");
}

/**
 * Fenced blocks whose info string is `<lang>:<relative path>`.
 * Used only when `manifest.yaml` is absent from runDir.
 */
function extractFencedBlocks(text: string): Map<string, string> {
  const headerRegex = /```(?:[a-zA-Z0-9_-]+):([^\n\r]+)/g;
  const matches: Array<{ file: string; start: number; headerIndex: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(text)) !== null) {
    matches.push({
      file: match[1].trim(),
      start: match.index + match[0].length,
      headerIndex: match.index,
    });
  }

  const blocks = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    let end: number;
    if (i + 1 < matches.length) {
      end = text.lastIndexOf("```", matches[i + 1].headerIndex - 1);
    } else {
      end = text.lastIndexOf("```");
    }
    const content = end > current.start ? text.slice(current.start, end) : text.slice(current.start);
    blocks.set(current.file, content.trim());
  }
  return blocks;
}

/**
 * Instruction files for the request template (rule 3): `none` gives none,
 * `project` gives the existing CLAUDE.md, AGENTS.md and SUBSTRATE.md in that
 * order. A list passed by the caller is used as given.
 */
function instructionFilesFor(opts: PlannerRunOptions): string[] {
  if (opts.instructionFiles) return opts.instructionFiles;
  if (opts.settings.instructions?.workers !== "project") return [];

  return INSTRUCTION_CANDIDATES.filter((name) =>
    fs.existsSync(path.resolve(opts.repoRoot, name))
  );
}

function money(value: number | undefined): string {
  return value === undefined ? "" : `$${value.toFixed(2)}`;
}

function addTotals(totals: UsageTotals, record: UsageRecord): UsageTotals {
  return {
    input_tokens: totals.input_tokens + (record.input_tokens ?? 0),
    output_tokens: totals.output_tokens + (record.output_tokens ?? 0),
    cost_usd: totals.cost_usd + (record.cost_usd ?? 0),
  };
}

function usageRecord(route: Route, totals: UsageTotals): UsageRecord {
  return {
    backend: route.backend,
    model: route.model,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cost_usd: totals.cost_usd,
    cost_source: "computed",
    at: new Date().toISOString(),
  };
}

async function requestVars(opts: PlannerRunOptions, route: Route): Promise<Record<string, string>> {
  let baseRef = "";
  try {
    baseRef = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: opts.repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    baseRef = "";
  }

  let ecosystem = "";
  try {
    ecosystem = await detectEcosystem(opts.repoRoot);
  } catch {
    ecosystem = "";
  }

  let mapText = "";
  try {
    const map = await generateRepoMap(opts.repoRoot);
    mapText = map.mapText;
  } catch {
    mapText = "";
  }

  const budgets = opts.settings.budgets;

  return {
    run_id: opts.runId,
    base_ref: baseRef,
    repo_root: opts.repoRoot,
    classes: "search, mechanical, boilerplate, tests, feature, refactor, debug, review",
    task_budget: money(budgets?.task?.max_usd),
    run_budget: money(budgets?.run?.max_usd),
    max_tasks: "",
    charter: "",
    history: "",
    repo_map: `Detected ecosystem: ${ecosystem}\n${mapText}`,
  };
}

export async function commitContractStubs(
  repoRoot: string,
  runId: RunId,
  baseRef: string,
  contracts: { files: string[]; typecheck: Command[] },
  runDir: string,
): Promise<string> {
  const branchName = `substrate/runs/${runId}`;

  // Ensure baseRef exists
  let parentCommit: string;
  try {
    parentCommit = execFileSync("git", ["rev-parse", baseRef], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    parentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  }

  // Create temporary index
  const tempIndexFile = path.join(
    runDir,
    `.git-index-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    const gitEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexFile,
      GIT_AUTHOR_NAME: "substrate-engine",
      GIT_AUTHOR_EMAIL: "substrate-engine@local",
      GIT_COMMITTER_NAME: "substrate-engine",
      GIT_COMMITTER_EMAIL: "substrate-engine@local",
    };

    // Read base tree into temp index
    execFileSync("git", ["read-tree", parentCommit], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: "utf8",
    });

    // Hash and add contract files
    for (const relFile of contracts.files) {
      const srcFile = path.resolve(runDir, relFile);
      if (fs.existsSync(srcFile)) {
        const blobSha = execFileSync(
          "git",
          ["hash-object", "-w", srcFile],
          { cwd: repoRoot, encoding: "utf8" },
        ).trim();

        execFileSync(
          "git",
          [
            "update-index",
            "--add",
            "--cacheinfo",
            "100644",
            blobSha,
            relFile.replace(/\\/g, "/"),
          ],
          { cwd: repoRoot, env: gitEnv, encoding: "utf8" },
        );
      }
    }

    // Write tree
    const treeSha = execFileSync("git", ["write-tree"], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: "utf8",
    }).trim();

    // Commit tree
    const commitSha = execFileSync(
      "git",
      [
        "commit-tree",
        treeSha,
        "-p",
        parentCommit,
        "-m",
        `feat(contracts): commit contract stubs for run ${runId}`,
      ],
      { cwd: repoRoot, env: gitEnv, encoding: "utf8" },
    ).trim();

    // Expected old value: the value the ref holds now, or the all-zero object id
    // when it does not exist yet. A ref that moved in between is not overwritten.
    let expectedOld = ZERO_OID;
    try {
      const current = execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      if (current !== "") expectedOld = current;
    } catch {
      expectedOld = ZERO_OID;
    }

    // Update branch reference
    execFileSync(
      "git",
      ["update-ref", `refs/heads/${branchName}`, commitSha, expectedOld],
      { cwd: repoRoot, encoding: "utf8" },
    );

    return commitSha;
  } finally {
    if (fs.existsSync(tempIndexFile)) {
      try {
        fs.unlinkSync(tempIndexFile);
      } catch {}
    }
  }
}

export async function runPlanner(
  opts: PlannerRunOptions,
): Promise<PlannerOutcome> {
  const settings = opts.settings;
  const route: Route =
    opts.route ?? {
      backend: settings.roles.planner.backend,
      model: settings.roles.planner.model,
      ...(settings.roles.planner.effort !== undefined
        ? { effort: settings.roles.planner.effort }
        : {}),
    };
  const maxAttempts = 1 + (settings.budgets?.planner_format_retries ?? 2);
  const instructionFiles = instructionFilesFor(opts);

  let totals: UsageTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  let sessionId = "";
  let diagnostics: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? await buildFirstPrompt(opts, route, instructionFiles)
        : buildCorrectionPrompt({
            attempt,
            max_attempts: maxAttempts,
            diagnostics,
          });

    const attemptSessionId = sessionId === "" ? crypto.randomUUID() : sessionId;

    const spawnReq: SpawnRequest = {
      role: "planner",
      cwd: opts.runDir,
      prompt: prompt.user,
      system_append: prompt.system,
      model: route.model,
      ...(route.effort !== undefined ? { effort: route.effort } : {}),
      permission: {
        allow: [opts.runDir],
        deny: DENY_PERMISSIONS,
      },
      budget: {
        max_usd: settings.budgets?.task?.max_usd ?? 5.0,
        timeout_ms: (settings.budgets?.task?.timeout_min ?? 30) * 60 * 1000,
        ...(settings.budgets?.task?.max_tokens
          ? { max_tokens: settings.budgets.task.max_tokens }
          : {}),
        ...(settings.budgets?.task?.timeout_min
          ? { timeout_min: settings.budgets.task.timeout_min }
          : {}),
      },
      // The planner does not know the session id before the first spawn, so it
      // generates one; a format error resumes that same session.
      ...(attempt === 1 ? { session: { id: attemptSessionId } } : { session: { resume: attemptSessionId } }),
    };

    const handle = opts.adapter.spawn(spawnReq);

    let sawUsageEvent = false;
    let sessionTotals: UsageTotals | undefined;
    for await (const evt of handle.events) {
      if (evt.type === "session.started") sessionId = evt.session_id;
      if (evt.type === "usage" && evt.record) {
        sawUsageEvent = true;
        const { delta, next } = toDelta(sessionTotals, evt.record, Boolean(evt.cumulative));
        sessionTotals = next;
        totals = addTotals(totals, delta);
        opts.onEvent?.("usage.recorded", { record: delta, role: "planner" });
      }
    }

    const res = await handle.result();
    if (res.session_id) sessionId = res.session_id;

    // Adapters that report usage only in the session result.
    if (!sawUsageEvent && res.usage) {
      totals = addTotals(totals, res.usage);
      opts.onEvent?.("usage.recorded", { record: res.usage, role: "planner" });
    }

    if (!res.ok || (res.exit_code !== null && res.exit_code !== 0)) {
      throw new PlannerFailure(
        "session",
        `Planner session failed with exit code ${res.exit_code}: ${res.final_text}`
      );
    }

    const line = finishLine(res.final_text);

    if (line === NEEDS_INPUT) {
      const questionsPath = path.resolve(opts.runDir, QUESTIONS_FILE);
      if (!fs.existsSync(questionsPath)) {
        diagnostics = [
          `finish line ${NEEDS_INPUT} requires ${QUESTIONS_FILE} in the run directory`,
        ];
        continue;
      }
      return {
        kind: "needs_input",
        questionsPath,
        sessionId,
        usage: usageRecord(route, totals),
      };
    }

    if (line !== PLAN_READY) {
      diagnostics = [
        `finish line must be ${PLAN_READY} or ${NEEDS_INPUT}`,
        `got: ${line || "(empty)"}`,
      ];
      continue;
    }

    const questionsPath = path.resolve(opts.runDir, QUESTIONS_FILE);
    if (fs.existsSync(questionsPath)) {
      diagnostics = [`${QUESTIONS_FILE} is present but the finish line is ${PLAN_READY}`];
      continue;
    }

    const manifestPath = path.resolve(opts.runDir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      const blocks = extractFencedBlocks(res.final_text);
      let unsafePath = "";
      for (const [relPath, content] of blocks.entries()) {
        if (!isSafeRelativePath(relPath)) {
          unsafePath = relPath;
          break;
        }
        const full = path.resolve(opts.runDir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
      }

      if (unsafePath !== "") {
        diagnostics = [`fenced block path is not relative to the run directory: ${unsafePath}`];
        continue;
      }

      if (!fs.existsSync(manifestPath)) {
        diagnostics = [`${MANIFEST_FILE} is missing from the run directory`];
        continue;
      }
    }

    let rawManifest = "";
    try {
      rawManifest = fs.readFileSync(manifestPath, "utf8");
    } catch (err: any) {
      diagnostics = [`Failed to read ${MANIFEST_FILE}: ${err.message}`];
      continue;
    }

    let manifest: Manifest;
    try {
      manifest = parseManifest(rawManifest, manifestPath);
    } catch (err: any) {
      diagnostics = [`Failed to parse ${MANIFEST_FILE}: ${err.message}`];
      continue;
    }

    const specs = new Map<TaskId, ParsedTaskSpec>();
    const problems: string[] = [];

    for (const task of manifest.tasks) {
      if (!isSafeRelativePath(task.spec)) {
        problems.push(`Task spec path resolves outside the run directory: ${task.spec}`);
        continue;
      }

      const specPath = path.resolve(opts.runDir, task.spec);
      if (!fs.existsSync(specPath)) {
        problems.push(`Spec file for task ${task.id} does not exist: ${task.spec}`);
        continue;
      }

      let rawSpec = "";
      try {
        rawSpec = fs.readFileSync(specPath, "utf8");
      } catch (err: any) {
        problems.push(`Failed to read task spec ${task.spec}: ${err.message}`);
        continue;
      }

      try {
        const parsedSpec = parseTaskSpec(rawSpec, task.spec);
        for (const heading of REQUIRED_HEADINGS) {
          if (!parsedSpec.sections.has(heading)) {
            problems.push(`Task spec ${task.spec} missing required heading: ## ${heading}`);
          }
        }
        specs.set(task.id, parsedSpec);
      } catch (err: any) {
        problems.push(`Failed to parse task spec ${task.spec}: ${err.message}`);
      }
    }

    if (problems.length > 0) {
      diagnostics = problems;
      continue;
    }

    const parsedPlan: ParsedPlan = { manifest, specs, rawManifest, manifestPath };

    const lintResult = await lintPlan(parsedPlan, opts.repoRoot, settings);
    const errors = lintResult.diagnostics.filter(
      (d) => d.severity === "error" && !isSuppressedForRunDir(opts.runDir, d)
    );
    if (errors.length > 0) {
      diagnostics = errors.map((d) => `[${d.code}] ${d.message}`);
      continue;
    }

    let typecheckRes;
    try {
      typecheckRes = await typecheckContracts(opts.runDir, manifest.contracts, {
        cwd: opts.runDir,
      });
    } catch (err: any) {
      typecheckRes = {
        ok: false,
        results: [],
        diagnostics: [{ code: "L018", severity: "error", message: err.message }],
      };
    }

    const typecheckErrors = typecheckRes.diagnostics.filter((d) => d.severity === "error");
    if (!typecheckRes.ok || typecheckErrors.length > 0) {
      diagnostics = typecheckErrors.length > 0
        ? typecheckErrors.map((d) => `[${d.code}] ${d.message}`)
        : ["Contract typecheck failed with a non-zero exit code"];
      continue;
    }

    const commitSha = await commitContractStubs(
      opts.repoRoot,
      opts.runId,
      manifest.base_ref ?? "HEAD",
      manifest.contracts,
      opts.runDir,
    );

    return {
      kind: "plan_ready",
      plan: parsedPlan,
      usage: usageRecord(route, totals),
      commitSha,
      sessionId,
    };
  }

  throw new PlannerFailure(
    "format",
    `Planner format retries exhausted after ${maxAttempts} attempts`,
    diagnostics
  );
}

async function buildFirstPrompt(
  opts: PlannerRunOptions,
  route: Route,
  instructionFiles: string[]
): Promise<{ system: string; user: string }> {
  const vars = await requestVars(opts, route);
  return buildPlannerPrompt({
    request: opts.request,
    repoMap: vars.repo_map,
    instructionFiles,
    skillsList: opts.skillsList,
    vars,
  });
}

/**
 * L003, L019 and L027 check the base commit for files the planner itself writes
 * into the run directory, so they are suppressed only when the referenced path
 * exists in runDir. No other code is suppressed.
 */
function isSuppressedForRunDir(runDir: string, diag: Diagnostic): boolean {
  if (diag.code !== "L003" && diag.code !== "L019" && diag.code !== "L027") return false;
  if (!diag.path) return false;
  if (!isSafeRelativePath(diag.path)) return false;
  return fs.existsSync(path.resolve(runDir, diag.path));
}
