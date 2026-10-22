import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {
  BackendName,
  Diagnostic,
  EngineEvent,
  FailurePacket,
  HarnessAdapter,
  Manifest,
  PauseReason,
  Route,
  RunId,
  SessionResult,
  Settings,
  SpawnRequest,
  TaskClass,
  TaskId,
  UsageRecord,
} from "../contracts/index.js";
import {
  parseEngineEvent,
  type EventData,
  type EventType,
} from "../contracts/events.js";
import {
  lintPlan,
  parseManifest,
  parseTaskSpec,
  typecheckContracts,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../spec/index.js";
import { toDelta, type UsageTotals } from "../ledger/usage.js";
import { bindAbort } from "../backends/process.js";
import { startHarnessSession } from "../backends/spawn.js";
import { commitContractStubs, finishLine, REQUIRED_HEADINGS } from "../roles/planner.js";
import { buildReplanL2Prompt, buildReplanPrompt } from "../roles/prompts/replan.js";
import { evaluateEscalation, type EscalationAction } from "./ladder.js";
import type { EngineState } from "./reducer.js";
import type { TypedEmit } from "./emit.js";

/**
 * The finish lines the planner templates (assets/prompts/planner/replan-l1.md and
 * replan-l2.md) tell the planner to end with. The wording of the prompts lives in the
 * templates; only the tokens the engine has to read to know which path the planner took
 * are here.
 */
const L1_FINISH = "REVISED";
const L2_FINISH = "AMENDED";
const NEEDS_INPUT = "NEEDS INPUT";
const ESCALATE_PREFIX = "ESCALATE:";

const MANIFEST_FILE = "manifest.yaml";

export interface ReplanExecutionOptions {
  runId: RunId;
  taskId: TaskId;
  packet: FailurePacket;
  state: EngineState;
  settings: Settings;
  /**
   * Adapter for runs that resolve a single backend. A run with an adapter map passes
   * `resolveAdapter` instead, so the backend the ladder routed to is the one used.
   */
  adapter?: HarnessAdapter;
  resolveAdapter?: (backend: BackendName) => HarnessAdapter | undefined;
  runDir: string;
  repoRoot: string;
  baseRef: string;
  decisionsLog?: string;
  /** Task class from the failed task's spec; the ladder default is "feature". */
  taskClass?: TaskClass;
  /** Prompt variables the engine supplies as data: the spec, the manifest, task states. */
  vars?: Record<string, string>;
  /** Emitter from the effects loop. Without it events are validated and observed. */
  emit?: TypedEmit;
  onEvent?: (event: EngineEvent) => void;
  /**
   * Called with each per-session usage delta and returns true when the caller has
   * stopped the run, so no further planner work is done. The run budget stays the
   * caller's decision: it never triggers replanning itself.
   */
  onUsage?: (delta: UsageRecord) => boolean;
  /** Run cancellation: the planner session is killed when this signal aborts. */
  signal?: AbortSignal;
}

export interface ReplanResult {
  level: "L0" | "L1" | "L2" | "L3";
  /** `failed`: the ladder has no step left for this task and no question for a person (R8.1). */
  status: "replan_ready" | "paused" | "healed" | "failed";
  action: EscalationAction;
  revisedSpec?: ParsedTaskSpec;
  revisedPlan?: ParsedPlan;
  packet: FailurePacket;
  diagnostics?: Diagnostic[];
  pauseReason?: PauseReason;
}

/**
 * Emitter for one replan. When the effects loop gives one, it is used; otherwise events
 * are validated against the catalog here, because nothing is recorded unless it is emitted.
 */
function makeEmit(opts: ReplanExecutionOptions): TypedEmit {
  let seq = 0;

  return <T extends EventType>(type: T, data: EventData<T>): EngineEvent => {
    if (opts.emit) {
      return opts.emit(type, data);
    }

    const evt = {
      v: 1,
      seq: seq + 1,
      ts: new Date().toISOString(),
      run_id: opts.runId,
      type,
      data,
    } as EngineEvent;
    seq += 1;

    parseEngineEvent(evt);
    opts.onEvent?.(evt);
    return evt;
  };
}

function pause(
  opts: ReplanExecutionOptions,
  emit: TypedEmit,
  reason: PauseReason,
  action: EscalationAction,
  questionsPath?: string,
): ReplanResult {
  // A task that can only continue with a human decision is BLOCKED (SUBSTRATE-PLAN
  // §Task states: "BLOCKED (upstream failed or needs human)"), so the failed task is
  // recorded as blocked before the run pauses. The reducer reaches BLOCKED only through
  // `task.blocked`, so the pause has to emit it rather than set the state directly.
  emit("task.blocked", { task_id: opts.taskId });
  emit("run.paused", { reason, ...(questionsPath ? { questions_path: questionsPath } : {}) });
  return { level: action.level, status: "paused", action, packet: opts.packet, pauseReason: reason };
}

export async function executeReplan(
  opts: ReplanExecutionOptions,
): Promise<ReplanResult> {
  const taskClass = opts.taskClass ?? "feature";
  const emit = makeEmit(opts);

  // Invariant: permission_denied and rate_limited never trigger replanning.
  if (opts.packet.failure_class === "permission_denied") {
    return pause(
      opts,
      emit,
      "permission_denied",
      { level: "L3", action: "pause", reason: "permission_denied" },
    );
  }

  if (opts.packet.failure_class === "rate_limited") {
    return pause(
      opts,
      emit,
      "rate_limited",
      { level: "L3", action: "pause", reason: "rate_limited" },
    );
  }

  const action = evaluateEscalation(
    opts.state,
    opts.taskId,
    opts.packet.failure_class,
    opts.settings,
    taskClass,
  );

  if (action.level === "L0") {
    return { level: "L0", status: "healed", action, packet: opts.packet };
  }

  if (action.level === "L3") {
    if (action.reason === "needs_human") {
      return giveUp(opts, emit, "replan budget exhausted: no step left and no question to ask", action);
    }
    return pause(opts, emit, action.reason, action);
  }

  if (action.level === "L1") {
    return runL1(opts, emit, action);
  }

  return runL2(opts, emit, "", action, opts.packet.generation + 1);
}

/**
 * L1: the planner gets the complete packet and writes back the replacement spec. The
 * output is accepted only when the finish line names this task and the file it wrote
 * parses and lints in the context of the current plan (rule 4). Anything else — an
 * `ESCALATE:` line, a missing spec, a spec that does not lint, any other final line —
 * is taken as an escalation to L2 (rule 5).
 */
async function runL1(
  opts: ReplanExecutionOptions,
  emit: TypedEmit,
  action: EscalationAction & { level: "L1" },
): Promise<ReplanResult> {
  emit("replan.started", {
    task_id: opts.taskId,
    generation: action.generation,
    target_tier: action.route.model,
    reason: opts.vars?.escalation_reason ?? "",
  });

  const prompt = buildReplanPrompt(opts.packet, opts.decisionsLog, {
    task_spec: readRunFile(opts.runDir, `tasks/${opts.taskId}.md`),
    ...opts.vars,
  });

  const outcome = await runPlannerSession(opts, emit, action.route, prompt);
  if (outcome.spawnFailure !== undefined) {
    return giveUp(opts, emit, "the planner could not start", action, outcome.spawnFailure);
  }
  if (outcome.cancelled) {
    return { level: "L1", status: "paused", action, packet: opts.packet, pauseReason: "user_cancel" };
  }
  if (outcome.unavailable) {
    return pause(opts, emit, "backend_unavailable", action);
  }
  if (outcome.stopped) {
    return pause(opts, emit, "budget_exhausted", action);
  }

  const line = finishLine(outcome.result.final_text);
  if (line === `${L1_FINISH} ${opts.taskId}`) {
    const spec = readRevisedSpec(opts);
    const diagnostics = await lintRunPlan(opts);
    if (spec && diagnostics.length === 0) {
      finishTask(opts, emit, action.generation);
      return {
        level: "L1",
        status: "replan_ready",
        action,
        revisedSpec: spec,
        revisedPlan: currentPlan(opts),
        packet: opts.packet,
      };
    }

    const reason =
      diagnostics.length > 0
        ? diagnostics.map((d) => `[${d.code}] ${d.message}`).join("; ")
        : "L1 wrote no readable spec";
    return escalateToL2(opts, emit, reason, action.generation);
  }

  const reason = line.startsWith(ESCALATE_PREFIX)
    ? line.slice(ESCALATE_PREFIX.length).trim()
    : line;
  return escalateToL2(opts, emit, reason, action.generation);
}

/**
 * The ladder cannot continue the task and there is no question for a person to answer:
 * the task is failed for good (`can_replan: false`, so it is BLOCKED and its dependents
 * are skipped), and the run ends failed once nothing else can run. A pause that waits
 * for a human is kept only for real questions (QUESTIONS.md), see `pause` (R8.1).
 */
function giveUp(
  opts: ReplanExecutionOptions,
  emit: TypedEmit,
  reason: string,
  action: EscalationAction,
  cause?: string,
): ReplanResult {
  // The failure the task carried is the reason a caller reads (an integration command,
  // a verify command); the ladder's own dead end is only the fallback. A planner that could not
  // start names its own cause (`cause`).
  const original = opts.state.tasks[opts.taskId]?.failure_message;
  emit("task.failed", {
    task_id: opts.taskId,
    generation: opts.packet.generation,
    failure_class: opts.packet.failure_class,
    can_replan: false,
    detail: cause ?? original ?? `replan gave up: ${reason}`,
  });
  return { level: action.level, status: "failed", action, packet: opts.packet };
}

/** Records the reason in `replan.started`, then takes L2 when the cap still allows it. */
function escalateToL2(
  opts: ReplanExecutionOptions,
  emit: TypedEmit,
  reason: string,
  nextGeneration: number,
): Promise<ReplanResult> {
  const action: EscalationAction =
    (opts.state.l2_count ?? 0) < opts.settings.budgets.l2_per_run
      ? { level: "L2", action: "contract_defect" }
      : { level: "L3", action: "pause", reason: "needs_human" };

  if (action.level === "L3") {
    return Promise.resolve(giveUp(opts, emit, reason, action));
  }

  // Rule 5: the escalation from L1 is recorded with the reason it happened, so the run
  // log shows which L1 output forced the amendment.
  emit("replan.started", {
    task_id: opts.taskId,
    generation: nextGeneration,
    target_tier: opts.settings.roles.planner.model,
    reason,
  });

  return runL2(opts, emit, reason, action, nextGeneration);
}

/**
 * L2: the planner amends contracts, the manifest and the affected specs. The counter is
 * recorded by the `replan.l2` event itself, so nothing is counted unless it is emitted.
 * Only dependents that have not merged are invalidated: merged work is never touched.
 */
async function runL2(
  opts: ReplanExecutionOptions,
  emit: TypedEmit,
  reason: string,
  action: EscalationAction,
  nextGeneration: number,
): Promise<ReplanResult> {
  const planner = opts.settings.roles.planner;
  const route: Route = {
    backend: planner.backend,
    model: planner.model,
    ...(planner.effort !== undefined ? { effort: planner.effort } : {}),
  };

  emit("replan.l2", {
    task_id: opts.taskId,
    generation: nextGeneration,
    invalidated: notMergedDependents(opts),
  });

  const prompt = buildReplanL2Prompt(opts.packet, {
    escalation_reason: reason,
    manifest: readRunFile(opts.runDir, MANIFEST_FILE),
    task_states: taskStates(opts.state),
    contracts: contractsText(opts),
    ...opts.vars,
  });

  const outcome = await runPlannerSession(opts, emit, route, prompt);
  if (outcome.spawnFailure !== undefined) {
    return giveUp(opts, emit, "the planner could not start", action, outcome.spawnFailure);
  }
  if (outcome.cancelled) {
    return { level: "L2", status: "paused", action, packet: opts.packet, pauseReason: "user_cancel" };
  }
  if (outcome.unavailable) {
    return pause(opts, emit, "backend_unavailable", action);
  }
  if (outcome.stopped) {
    return pause(opts, emit, "budget_exhausted", action);
  }

  const line = finishLine(outcome.result.final_text);

  if (line === NEEDS_INPUT) {
    // A pause waits for a person only when the planner left questions to answer.
    const questionsPath = path.join(opts.runDir, "QUESTIONS.md");
    if (!fs.existsSync(questionsPath)) {
      return giveUp(opts, emit, "planner asked for input but wrote no QUESTIONS.md", action);
    }
    return pause(opts, emit, "needs_human", action, questionsPath);
  }

  if (line !== L2_FINISH) {
    return giveUp(opts, emit, `invalid L2 finish line: ${line}`, action);
  }

  const plan = currentPlan(opts);
  const diagnostics = await lintRunPlan(opts);
  if (plan && diagnostics.length > 0) {
    return giveUp(
      opts,
      emit,
      `L2 amendment does not lint: ${diagnostics.map((d) => `[${d.code}] ${d.message}`).join("; ")}`,
      action,
    );
  }

  if (plan) {
    const typecheck = await typecheckContracts(opts.runDir, plan.manifest.contracts, {
      cwd: opts.runDir,
    });
    if (!typecheck.ok) {
      return giveUp(
        opts,
        emit,
        `L2 contracts do not typecheck: ${typecheck.diagnostics.map((d) => d.message).join("; ")}`,
        action,
      );
    }

    const commitSha = await commitContractStubs(
      opts.repoRoot,
      opts.runId,
      opts.baseRef,
      plan.manifest.contracts,
      opts.runDir,
    );
    emit("contracts.committed", { commit_sha: commitSha });
  }

  const invalidated = notMergedDependents(opts);
  if (invalidated.length > 0) {
    emit("tasks.invalidated", { task_ids: invalidated });
  }

  finishTask(opts, emit, nextGeneration);

  return {
    level: "L2",
    status: "replan_ready",
    action,
    revisedPlan: plan,
    packet: opts.packet,
  };
}

/**
 * The end of a replan: the task moves to the next generation, and `task.ready` is emitted
 * only when the tasks it depends on have merged, because a dependent worktree is built
 * from the run branch and can only see work that is already merged.
 */
function finishTask(opts: ReplanExecutionOptions, emit: TypedEmit, generation: number): void {
  emit("task.replanned", { task_id: opts.taskId, generation });
  emit("replan.finished", { task_id: opts.taskId, generation });

  const deps = opts.state.tasks[opts.taskId]?.depends_on ?? [];
  if (deps.every((dep) => opts.state.tasks[dep]?.state === "MERGED")) {
    emit("task.ready", { task_id: opts.taskId });
  }
}

/**
 * The plan's transitive dependents of the failed task that are not merged, in id order
 * (R3.5 rule 7). The failed task itself is not in the list: rule 7 moves it to the next
 * generation instead, and walking `depends_on` would go upstream, not downstream. The
 * state is what is true now, so a dependent that merged in the meantime is never
 * invalidated.
 */
function notMergedDependents(opts: ReplanExecutionOptions): string[] {
  return opts.packet.dependents
    .filter((id) => id !== opts.taskId)
    .filter((id) => {
      const task = opts.state.tasks[id];
      return task !== undefined && task.state !== "MERGED";
    })
    .sort((a, b) => a.localeCompare(b));
}

function readRunFile(runDir: string, relPath: string): string {
  try {
    return fs.readFileSync(path.resolve(runDir, relPath), "utf8");
  } catch {
    return "";
  }
}

function taskStates(state: EngineState): string {
  return Object.values(state.tasks)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => `${t.id}: ${t.state} (generation ${t.generation}, attempt ${t.attempt})`)
    .join("\n");
}

function contractsText(opts: ReplanExecutionOptions): string {
  const plan = currentPlan(opts);
  if (!plan) return "";
  return plan.manifest.contracts.files
    .map((file) => `${file}\n${readRunFile(opts.runDir, file)}`)
    .join("\n\n");
}

/** The plan as it stands in the run directory, read back from what was written. */
function currentPlan(opts: ReplanExecutionOptions): ParsedPlan | undefined {
  const manifestPath = path.join(opts.runDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return undefined;

  const rawManifest = readRunFile(opts.runDir, MANIFEST_FILE);
  let manifest: Manifest;
  try {
    manifest = parseManifest(rawManifest, manifestPath);
  } catch {
    return undefined;
  }

  const specs = new Map<TaskId, ParsedTaskSpec>();
  for (const task of manifest.tasks) {
    if (!isSafeRelativePath(task.spec)) continue;
    const specPath = path.resolve(opts.runDir, task.spec);
    if (!fs.existsSync(specPath)) continue;
    try {
      specs.set(task.id, parseTaskSpec(fs.readFileSync(specPath, "utf8"), task.spec));
    } catch {
      // A spec that does not parse is reported by lintRunPlan; nothing is invented for it.
    }
  }

  return { manifest, specs, rawManifest, manifestPath };
}

/**
 * Validation for the L1 and L2 outputs: the required headings (the same list the planner
 * checks, src/roles/planner.ts) and the lint rules, with the run-directory suppression of
 * R3.1 rule 7 because the revised spec and the amended manifest live in runDir before
 * they are committed.
 */
async function lintRunPlan(opts: ReplanExecutionOptions): Promise<Diagnostic[]> {
  const plan = currentPlan(opts);
  if (!plan) {
    return [{ code: "REPLAN", severity: "error", message: "No plan in the run directory" }];
  }

  const diagnostics: Diagnostic[] = [];
  for (const task of plan.manifest.tasks) {
    const spec = plan.specs.get(task.id);
    if (!spec) continue;
    for (const heading of REQUIRED_HEADINGS) {
      if (!spec.sections.has(heading)) {
        diagnostics.push({
          code: "REPLAN",
          severity: "error",
          path: task.spec,
          message: `Task spec ${task.spec} missing required heading: ## ${heading}`,
        });
      }
    }
  }

  const result = await lintPlan(plan, opts.repoRoot, opts.settings);
  for (const diag of result.diagnostics) {
    if (diag.severity === "error" && !isSuppressedForRunDir(opts.runDir, diag)) {
      diagnostics.push(diag);
    }
  }

  return diagnostics;
}

function isSuppressedForRunDir(runDir: string, diag: Diagnostic): boolean {
  if (diag.code !== "L003" && diag.code !== "L019" && diag.code !== "L027") return false;
  if (!diag.path) return false;
  if (!isSafeRelativePath(diag.path)) return false;
  return fs.existsSync(path.resolve(runDir, diag.path));
}

function isSafeRelativePath(relPath: string): boolean {
  return !path.isAbsolute(relPath) && !relPath.startsWith("..");
}

function readRevisedSpec(opts: ReplanExecutionOptions): ParsedTaskSpec | undefined {
  const specRel = `tasks/${opts.taskId}.md`;
  const specPath = path.resolve(opts.runDir, specRel);
  if (!fs.existsSync(specPath)) return undefined;
  try {
    return parseTaskSpec(fs.readFileSync(specPath, "utf8"), specRel);
  } catch {
    return undefined;
  }
}

interface SessionOutcome {
  result: SessionResult;
  /** True when the caller stopped the session (run budget), so no output is read. */
  stopped: boolean;
  /** True when no adapter answers for the backend the ladder routed to. */
  unavailable: boolean;
  /** True when the run was cancelled, so nothing is recorded for this replan. */
  cancelled: boolean;
  /** Set when the planner session could not start at all (after the spawn retries): the spawn error in plain words. */
  spawnFailure?: string;
}

async function runPlannerSession(
  opts: ReplanExecutionOptions,
  emit: TypedEmit,
  route: Route,
  prompt: { system: string; user: string },
): Promise<SessionOutcome> {
  const adapter = opts.resolveAdapter?.(route.backend) ?? opts.adapter;
  if (!adapter) {
    return { result: emptyResult(), stopped: false, unavailable: true, cancelled: false };
  }

  const request: SpawnRequest = {
    role: "planner",
    cwd: opts.runDir,
    prompt: prompt.user,
    system_append: prompt.system,
    model: route.model,
    ...(route.effort !== undefined ? { effort: route.effort } : {}),
    permission: {
      allow: [opts.runDir],
      deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
    },
    budget: {
      max_usd: opts.settings.budgets.task.max_usd,
      ...(opts.settings.budgets.task.timeout_min !== undefined
        ? { timeout_ms: opts.settings.budgets.task.timeout_min * 60 * 1000 }
        : {}),
      ...(opts.settings.budgets.task.max_tokens
        ? { max_tokens: opts.settings.budgets.task.max_tokens }
        : {}),
    },
    raw_dir: opts.runDir,
    session: { id: crypto.randomUUID() },
  };

  // A planner that cannot start gives up this one task (R13.1); it does not throw out of the engine.
  const started = await startHarnessSession(adapter, request).then(
    (handle) => ({ handle }),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
  if ("error" in started) {
    return {
      result: emptyResult(),
      stopped: false,
      unavailable: false,
      cancelled: false,
      spawnFailure: started.error,
    };
  }
  const handle = started.handle;
  const unbind = bindAbort(opts.signal, handle);
  let totals: UsageTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  let sawUsage = false;

  try {
    for await (const evt of handle.events) {
      if (evt.type !== "usage") continue;
      sawUsage = true;
      const { delta, next } = toDelta(totals, evt.record, evt.cumulative);
      totals = next;
      emit("usage.recorded", {
        record: delta,
        role: "planner",
        task_id: opts.taskId,
        generation: opts.packet.generation,
      });
      if (opts.onUsage?.(delta)) {
        await handle.kill("budget");
        return { result: emptyResult(), stopped: true, unavailable: false, cancelled: false };
      }
    }

    const result = await handle.result();

    // Session-result usage for adapters that never stream usage reports (R1.4).
    if (!sawUsage && result.usage) {
      emit("usage.recorded", {
        record: result.usage,
        role: "planner",
        task_id: opts.taskId,
        generation: opts.packet.generation,
      });
      if (opts.onUsage?.(result.usage)) {
        return { result, stopped: true, unavailable: false, cancelled: false };
      }
    }

    if (opts.signal?.aborted || result.killed_for === "cancel") {
      return { result, stopped: true, unavailable: false, cancelled: true };
    }

    return { result, stopped: false, unavailable: false, cancelled: false };
  } finally {
    unbind();
  }
}

function emptyResult(): SessionResult {
  return {
    ok: false,
    session_id: "",
    final_text: "",
    usage: {
      backend: "fake",
      model: "",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      cost_source: "unknown",
      at: new Date().toISOString(),
    },
    exit_code: null,
    denials: [],
  };
}
