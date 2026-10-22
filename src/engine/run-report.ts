import type { EngineEvent, RunSummary } from "../contracts/index.js";
import { applyJournalEvent } from "./journal.js";
import type { EngineState, TaskRuntimeState } from "./reducer.js";
import { failureOf, repairOf, repairedOf, startBranchOf, verificationOf } from "./landing.js";
import { failedRunResume, failedRunTail } from "./failed-run.js";

// The run report (P2.2): one structured account of how a run ended, built from what is on disk. It is pure:
// the caller reads the event log and the file facts (packets, branch, commits) and passes them in. The text,
// Markdown and json forms are all rendered from this one object, so they cannot disagree.

export type ReportOutcome =
  | "finished"
  | "planned"
  | "failed"
  | "paused"
  | "interrupted"
  | "internal_error"
  | "stopped_uncleanly";

export type TaskOutcome = "passed" | "failed" | "skipped" | "interrupted" | "not_started";

/** One worker attempt, read from packets/<task>-g<n>-attempt<k>.json. Only the fields the report uses. */
export interface AttemptFacts {
  task_id: string;
  generation: number;
  attempt: number;
  files_changed?: string[];
  verify?: Array<{ cmd: string; exit_code: number | null; timed_out?: boolean; stdout_tail?: string; stderr_tail?: string }>;
}

/** The file facts the caller reads for a run. Every field is optional: a missing fact is left out, never invented. */
export interface ReportFacts {
  /** The run directory, relative to the project. Default: `.substrate/runs/<run id>`. */
  run_dir?: string;
  /** The run branch, when it exists. */
  branch?: string;
  /** The branch the run started on (when the run.created event does not name it). */
  base_branch?: string;
  /** Commit subjects on the run branch above its base, newest first. */
  commits?: string[];
  /** Names of the saved patches directly under packets/ (for example `T2-g1.patch`). */
  patches?: string[];
  /** The worker attempt reports. */
  attempts?: AttemptFacts[];
}

export interface ReportInput {
  runId: string;
  /** The run's event log, oldest first. Empty when only the summary is known. */
  events?: EngineEvent[];
  /** The summary the run returned, when there is one (landing fields, exit code). */
  summary?: RunSummary;
  facts?: ReportFacts;
}

export interface TaskReport {
  id: string;
  title?: string;
  state: TaskOutcome;
  generation: number;
  /** Heals the worker made on this task (task.healing events). */
  fixes: number;
  /** Replans the ladder ran for this task: generations after the first. */
  replans: number;
  /** Changed file names of the task's latest attempt (capped at 10). */
  files_changed: string[];
  files_changed_total: number;
  failure_class?: string;
  /** The failure's own message or detail, as recorded (bounded to 200 characters). */
  message?: string;
  /** The failure in plain words (see plainReasonOf). */
  plain_reason?: string;
  /** The verify command that failed in the task's latest attempt. */
  failing_command?: string;
  /** The last ten non-empty lines of that command's output. */
  output_tail?: string[];
  /** The saved patch of the task's latest failed generation, under the project. */
  patch_path?: string;
  /** The plan's setup that failed in the task's worktree (R13.1). The worker ran anyway. */
  setup_failed?: { command: string; reason: string };
  /** R13.1: why the task's verify could not run; the task passed without it. */
  verification_not_run?: string;
}

export interface RunReport {
  run_id: string;
  outcome: ReportOutcome;
  /** One plain sentence: what happened and what it left. */
  verdict: string;
  merged: boolean;
  tasks: TaskReport[];
  produced: {
    branch?: string;
    base_branch?: string;
    /** Commit subjects above the base, newest first (capped at 5). */
    commits: string[];
    commit_count: number;
    /** Saved patch paths, relative to the project (capped at 5). */
    patches: string[];
    run_dir: string;
  };
  integration: {
    result: "none" | "passed" | "failed" | "not_run" | "skipped";
    reason?: string;
    command?: string;
    output_tail: string[];
    repaired?: number;
  };
  recovery: {
    fixes: number;
    l1_replans: number;
    l2_replans: number;
    repairs: number;
    repair?: { attempts: number; passed: boolean; reason?: string; outcomes: string[] };
    /** The one sentence that says why the engine stopped trying. */
    stopped_because?: string;
  };
  /** The run's failure: the raw class and message (as the Reason line has always shown them) and its plain words. */
  failure?: { failure_class: string; message?: string; plain_reason: string };
  next: string[];
}

/** The plain-words sentence for each failure class (R8.1). A class not listed falls back to the raw class and message. */
const PLAIN_CLASS: Record<string, string> = {
  verify_failed: "a verify command failed",
  scope_violation: "it changed files outside the task's write set",
  protected_modified: "it changed a protected file",
  budget_exceeded: "its spend limit was exceeded",
  timeout: "it ran past its time limit",
  worker_crashed: "the worker process exited without finishing",
  permission_denied: "the harness denied a permission the task needed",
  rate_limited: "the model provider rate-limited the run",
  merge_conflict: "its changes conflict with another task's changes",
  integration_failed: "the final check failed with the combined changes",
  spec_invalid: "the plan or a task spec was not valid",
  budget_exhausted: "the run budget was reached",
  internal_error: "Substrate hit an internal error",
};

const PLAIN_PAUSE: Record<string, string> = {
  budget_exhausted: "the run budget was reached",
  timeout: "the run's time limit was reached",
  needs_human: "it needs your answers",
  needs_approval: "the plan needs your approval",
  rate_limited: "the model provider rate-limited the run",
  permission_denied: "the harness asked for a permission the run does not have",
  backend_unavailable: "the harness is not available",
};

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const FILES_LIMIT = 10;
const TAIL_LINES = 10;
const COMMITS_LIMIT = 5;
const PATCHES_LIMIT = 5;

/** The plain-words reason for a failure class. A class the table does not name keeps its raw class and message. */
export function plainReasonOf(failureClass: string | undefined, message?: string): string {
  if (failureClass === undefined) return message ?? "the task did not finish";
  const plain = PLAIN_CLASS[failureClass];
  if (plain !== undefined) return plain;
  return message !== undefined && message !== "" ? `${failureClass}: ${message}` : failureClass;
}

function data(event: EngineEvent): Record<string, any> {
  return event.data !== null && typeof event.data === "object" ? (event.data as Record<string, any>) : {};
}

function countOf(events: EngineEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

/** The last plan.produced event's tasks (id, title, depends_on) and its manifest, if any. */
function planOf(events: EngineEvent[]): { tasks: Array<{ id: string; title?: string; depends_on: string[] }>; integrationVerify: number } {
  const produced = [...events].reverse().find((e) => e.type === "plan.produced");
  if (produced === undefined) return { tasks: [], integrationVerify: 0 };
  const d = data(produced);
  const tasks = Array.isArray(d.tasks)
    ? d.tasks
        .filter((t: any) => t && typeof t.id === "string")
        .map((t: any) => ({
          id: t.id as string,
          ...(typeof t.title === "string" ? { title: t.title } : {}),
          depends_on: Array.isArray(t.depends_on) ? (t.depends_on as string[]) : [],
        }))
    : [];
  const verify = Array.isArray(d.manifest?.integration_verify) ? d.manifest.integration_verify.length : 0;
  return { tasks, integrationVerify: verify };
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

function initialState(runId: string): EngineState {
  return { run_id: runId as EngineState["run_id"], state: "CREATED", tasks: {}, usage: { total_usd: 0, by_role: {} }, checkpoints: [] };
}

/** The reducer's state name for a summary's status, used when no event log is given. */
function stateNameOf(summary: RunSummary | undefined): string {
  switch (summary?.status) {
    case "finished":
      return "FINISHED";
    case "planned":
      return "PLANNED";
    case "failed":
      return "FAILED";
    case "paused":
      return "PAUSED";
    case "cancelled":
      return "CANCELLED";
    default:
      return "CREATED";
  }
}

function outcomeOfTask(t: TaskRuntimeState | undefined, summaryState?: string): TaskOutcome {
  if (t === undefined) {
    if (summaryState === "PASSED") return "passed";
    if (summaryState === "FAILED") return "failed";
    if (summaryState === "SKIPPED") return "skipped";
    return "not_started";
  }
  switch (t.state) {
    case "PASSED":
    case "MERGED":
      return "passed";
    case "ABANDONED":
      return "skipped";
    case "FAILED":
      return "failed";
    case "BLOCKED":
      return t.failure_class !== undefined ? "failed" : "skipped";
    case "PENDING":
    case "READY":
      return "not_started";
    default:
      return "interrupted";
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** The last non-empty lines of a command's output, as an array. */
function tailLines(text: string | undefined, max = TAIL_LINES): string[] {
  if (text === undefined) return [];
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");
  return lines.slice(-max);
}

function outcomeOfRun(runState: string, failure: { failure_class: string } | undefined, pauseReason: string | undefined): ReportOutcome {
  switch (runState) {
    case "FINISHED":
      return "finished";
    case "PLANNED":
      return "planned";
    case "FAILED":
      return failure?.failure_class === "internal_error" ? "internal_error" : "failed";
    case "PAUSED":
      return pauseReason === "user_cancel" ? "interrupted" : "paused";
    case "CANCELLED":
      return "interrupted";
    default:
      // A run whose log has no end: its process was killed, or the machine stopped under it.
      return "stopped_uncleanly";
  }
}

function pauseStopText(reason: string | undefined): string {
  if (reason === undefined) return "the run paused";
  return PLAIN_PAUSE[reason] ?? `the run paused (${reason})`;
}

function pluralWord(n: number, one: string, many: string): string {
  return `${WORDS[n] ?? String(n)} ${n === 1 ? one : many}`;
}

/** Builds the run report. Pure: the caller reads the files, and no clock, process or disk is touched here. */
export function buildRunReport(input: ReportInput): RunReport {
  const runId = input.runId;
  const events = input.events ?? [];
  const facts = input.facts ?? {};
  const summary = input.summary;
  const hasEvents = events.length > 0;
  const state = events.reduce((s, e) => applyJournalEvent(s, e), initialState(runId));
  const runState = hasEvents ? state.state : stateNameOf(summary);
  const pauseReason = hasEvents ? state.pause_reason : summary?.pause_reason;

  const summaryMessage = summary?.message !== undefined && summary.message !== "" ? summary.message : undefined;
  const failure =
    summary?.failure_class !== undefined
      ? { failure_class: summary.failure_class, ...(summaryMessage !== undefined ? { message: summaryMessage } : {}) }
      : failureOf(events);
  const outcome = outcomeOfRun(runState, failure, pauseReason);

  const plan = planOf(events);
  const attempts = facts.attempts ?? [];
  const patchNames = facts.patches ?? [];
  const runDir = facts.run_dir ?? `.substrate/runs/${runId}`;

  // The tasks: every task the plan named, and every task the state holds, in task-id order.
  const ids = new Set<string>([...plan.tasks.map((t) => t.id), ...Object.keys(state.tasks), ...Object.keys(summary?.tasks ?? {})]);
  const summaryTasks = summary?.tasks ?? {};
  const planById = new Map(plan.tasks.map((t) => [t.id, t] as const));
  const sortedIds = [...ids].sort(naturalCompare);

  const taskStateOf = (id: string): TaskOutcome => {
    if (!hasEvents && summaryTasks[id] !== undefined) return outcomeOfTask(undefined, summaryTasks[id].state);
    return outcomeOfTask(state.tasks[id]);
  };

  const tasks: TaskReport[] = sortedIds.map((id) => {
    const t = state.tasks[id] as TaskRuntimeState | undefined;
    const st = taskStateOf(id);
    const generation = t?.generation ?? summaryTasks[id]?.generation ?? 1;
    const failureClass = t?.failure_class ?? summaryTasks[id]?.failure_class;
    const message = t?.failure_message;
    const own = attempts.filter((a) => a.task_id === id).sort((a, b) => b.generation - a.generation || b.attempt - a.attempt);
    const latest = own[0];
    const failingEntry = own
      .flatMap((a) => (a.verify ?? []).map((v) => ({ v })))
      .find(({ v }) => v.exit_code !== 0 || v.timed_out === true);
    // The newest saved patch of this task: `<task>-g<n>.patch`, the highest generation.
    const patchName = patchNames
      .map((p) => ({ p, m: /^(.+)-g(\d+)\.patch$/.exec(p) }))
      .filter((x) => x.m !== null && x.m[1] === id)
      .sort((a, b) => Number(b.m![2]) - Number(a.m![2]))[0]?.p;
    const deps = planById.get(id)?.depends_on ?? [];
    const failedDeps = deps.filter((d) => {
      const dep = state.tasks[d];
      return outcomeOfTask(dep) === "failed" || outcomeOfTask(dep) === "skipped";
    });
    let plainReason: string | undefined;
    if (st === "failed") plainReason = plainReasonOf(failureClass, message);
    else if (st === "skipped") plainReason = `skipped: it depends on ${failedDeps.join(", ") || "a task that did not pass"}`;
    else if (st === "interrupted") plainReason = "the run stopped while it was working on this task";
    const files = latest?.files_changed ?? [];
    return {
      id,
      ...(planById.get(id)?.title !== undefined ? { title: planById.get(id)?.title } : {}),
      state: st,
      generation,
      fixes: events.filter((e) => e.type === "task.healing" && data(e).task_id === id).length,
      replans: Math.max(0, generation - 1),
      files_changed: files.slice(0, FILES_LIMIT),
      files_changed_total: files.length,
      ...(failureClass !== undefined ? { failure_class: failureClass } : {}),
      ...(message !== undefined ? { message: clip(message, 200) } : {}),
      ...(plainReason !== undefined ? { plain_reason: plainReason } : {}),
      ...(st === "failed" && failingEntry !== undefined ? { failing_command: failingEntry.v.cmd } : {}),
      ...(st === "failed" && failingEntry !== undefined
        ? { output_tail: tailLines([failingEntry.v.stdout_tail, failingEntry.v.stderr_tail].filter((x) => x !== undefined).join("\n")) }
        : {}),
      ...(patchName !== undefined && (st === "failed" || st === "interrupted") ? { patch_path: `${runDir}/packets/${patchName}` } : {}),
      ...(state.tasks[id]?.setup_failed !== undefined ? { setup_failed: state.tasks[id].setup_failed } : {}),
      ...(state.tasks[id]?.verification_not_run !== undefined ? { verification_not_run: state.tasks[id].verification_not_run } : {}),
    };
  });

  const passed = tasks.filter((t) => t.state === "passed").length;
  const failedTasks = tasks.filter((t) => t.state === "failed");
  const skipped = tasks.filter((t) => t.state === "skipped").length;
  const total = tasks.length;

  // The final check (R12.2, R12.4).
  const verification = hasEvents
    ? verificationOf(events)
    : summary?.verification !== undefined
      ? { verification: summary.verification, ...(summary.verification_note !== undefined ? { note: summary.verification_note } : {}) }
      : undefined;
  const integrationEvent = [...events].reverse().find((e) => e.type === "integration.failed");
  const integrationData = integrationEvent !== undefined ? data(integrationEvent) : undefined;
  const repair = hasEvents ? repairOf(events) : summary?.repair;
  const repaired = hasEvents ? repairedOf(events) : summary?.repaired;
  const integrationResult: RunReport["integration"]["result"] =
    verification === undefined
      ? "none"
      : verification.verification === "passed"
        ? "passed"
        : verification.verification === "failed"
          ? "failed"
          : verification.verification === "skipped"
            ? "skipped"
            : "not_run";
  const integrationReason =
    integrationResult === "failed"
      ? integrationData !== undefined
        ? typeof integrationData.message === "string"
          ? integrationData.message
          : undefined
        : failedTasks.find((t) => t.failure_class === "integration_failed")?.message
      : integrationResult === "not_run"
        ? verification?.note
        : undefined;
  const integration: RunReport["integration"] = {
    result: integrationResult,
    ...(integrationReason !== undefined ? { reason: integrationReason } : {}),
    ...(typeof integrationData?.command === "string" ? { command: integrationData.command } : {}),
    output_tail: typeof integrationData?.output_tail === "string" ? tailLines(integrationData.output_tail) : [],
    ...(repaired !== undefined ? { repaired } : {}),
  };

  // What the engine tried (events only). The L2 replans are the replan.l2 events; the L1 replans are the other starts.
  const l2 = countOf(events, "replan.l2");
  const recovery: RunReport["recovery"] = {
    fixes: countOf(events, "task.healing"),
    l1_replans: Math.max(0, countOf(events, "replan.started") - l2),
    l2_replans: l2,
    repairs: repair?.attempts ?? 0,
    ...(repair !== undefined ? { repair } : {}),
  };

  const merged = summary?.merged === true;
  const base = facts.base_branch ?? startBranchOf(events) ?? summary?.base_branch;
  const branch = facts.branch ?? summary?.branch;

  // The sentence that says why the engine stopped trying (or why the run ended as it did).
  const stoppedBecause = ((): string | undefined => {
    switch (outcome) {
      case "finished":
      case "planned":
        return undefined;
      case "interrupted":
        return "you stopped the run (Ctrl-C or substrate stop)";
      case "stopped_uncleanly":
        return "its process ended without recording an end (it was killed, or the machine stopped)";
      case "paused":
        return pauseStopText(pauseReason);
      case "internal_error":
        return "an internal error stopped the run";
      case "failed": {
        if (total === 0) return "planning failed";
        if (failure?.failure_class === "integration_failed" || integrationResult === "failed" || integrationResult === "not_run") {
          if (integrationResult === "not_run") return "the final check could not run";
          if (recovery.repairs > 0) return `the final check still fails after ${pluralWord(recovery.repairs, "repair attempt", "repair attempts")}`;
          return "the final check failed";
        }
        const conflict = failedTasks.find((t) => t.failure_class === "merge_conflict");
        if (conflict !== undefined) {
          const named = /conflicts with (.+?) on /.exec(conflict.message ?? "")?.[1];
          return named !== undefined ? `merge conflict with ${named}` : "merge conflict";
        }
        const first = failedTasks[0];
        if (first !== undefined) return first.replans > 0 ? "the replan budget ran out" : "no automatic fix applies to this failure";
        return failure !== undefined ? plainReasonOf(failure.failure_class, failure.message) : "the run failed";
      }
    }
  })();

  const verdict = ((): string => {
    switch (outcome) {
      case "finished":
        if (merged) return `Merged into ${base ?? "your branch"}: ${passed} of ${total} tasks passed.`;
        return `Finished, but not merged: ${(summary?.not_merged_reason ?? "there was nothing to merge").replace(/^not merged: /, "").replace(/\.$/, "")}.`;
      case "planned":
        return `Planned ${pluralWord(total, "task", "tasks")}; nothing was run yet.`;
      case "interrupted":
        return `Stopped by you before the run finished; ${passed} of ${total} tasks finished.`;
      case "stopped_uncleanly":
        return `The run stopped without finishing, and no end was recorded: ${passed} of ${total} tasks finished.`;
      case "paused":
        return `Paused: ${stoppedBecause}. ${passed} of ${total} tasks finished.`;
      case "internal_error":
        return `Nothing was merged. Substrate hit an internal error${failure?.message ? `: ${clip(failure.message, 160)}` : ""}.`;
      case "failed": {
        const head = merged ? "Merged." : "Nothing was merged.";
        if (total === 0) return `${head} Planning failed: ${plainReasonOf(failure?.failure_class, failure?.message)}.`;
        if (failedTasks.length === 0 && (integrationResult === "failed" || integrationResult === "not_run")) {
          if (integrationResult === "not_run") return `${head} All ${pluralWord(total, "task", "tasks")} passed their own checks, but the final check could not run.`;
          const after = recovery.repairs > 0 ? ` after ${pluralWord(recovery.repairs, "repair attempt", "repair attempts")}` : "";
          return `${head} All ${pluralWord(total, "task", "tasks")} passed their own checks, but the final check failed${after}.`;
        }
        const first = failedTasks[0];
        let body = `${passed} of ${total} tasks finished`;
        if (first !== undefined) {
          const parts: string[] = [];
          if (first.fixes > 0) parts.push(pluralWord(first.fixes, "fix", "fixes"));
          if (first.replans > 0) parts.push(pluralWord(first.replans, "replan", "replans"));
          const ids = failedTasks.map((t) => t.id).join(", ");
          body += `; ${ids} failed${parts.length > 0 ? ` after ${parts.join(" and ")}` : `, ${first.plain_reason ?? "it did not pass"}`}`;
        }
        if (skipped > 0) body += `; ${skipped} skipped`;
        return `${head} ${body}${stoppedBecause !== undefined ? ` (${stoppedBecause})` : ""}.`;
      }
    }
  })();

  if (stoppedBecause !== undefined) recovery.stopped_because = stoppedBecause;

  // The commands that continue or inspect the run, in the order a person needs them.
  const next: string[] = [];
  const patchPaths = tasks.map((t) => t.patch_path).filter((p): p is string => p !== undefined);
  const hasPartialLanding = events.some((e) => e.type === "task.merged") && plan.integrationVerify > 0 && branch !== undefined;
  // Every task merged and the final check failed: `merge --partial` would rerun the same failing check, so it is
  // not offered (the resume and the inspect lines are).
  const verifyOnly = integrationResult === "failed" && total > 0 && passed === total;
  if (outcome === "failed" || outcome === "internal_error") {
    next.push(
      ...failedRunResume(runId, {
        partialLandable: hasPartialLanding && !verifyOnly,
        planningFailed: total === 0,
        verifyOnly,
        internalError: outcome === "internal_error",
      }),
    );
  } else if (outcome === "paused" && pauseReason === "needs_human") {
    next.push(`substrate resume ${runId} --answers <file>`);
  } else if (outcome === "paused" || outcome === "interrupted" || outcome === "stopped_uncleanly") {
    const resume = summary?.next?.find((c) => c.startsWith("substrate resume "));
    next.push(resume ?? `substrate resume ${runId}`);
  } else if (outcome === "finished" && !merged) {
    next.push(summary?.next?.[0] ?? `substrate merge ${runId}`);
  } else if (outcome === "planned") {
    next.push(...(summary?.next ?? []));
  }
  if (branch !== undefined && base !== undefined && (outcome === "failed" || outcome === "paused" || outcome === "interrupted" || outcome === "stopped_uncleanly" || outcome === "internal_error")) {
    next.push(`git diff ${base}..${branch}`);
  }
  if (outcome === "failed" && patchPaths.length > 0) next.push(`git apply ${patchPaths[0]}`);
  if (outcome !== "finished" && outcome !== "planned") next.push(`substrate status ${runId}`);
  if (outcome === "failed" || outcome === "internal_error") next.push(...failedRunTail(runId, { internalError: outcome === "internal_error" }));

  const produced: RunReport["produced"] = {
    ...(branch !== undefined ? { branch } : {}),
    ...(base !== undefined ? { base_branch: base } : {}),
    commits: (facts.commits ?? []).slice(0, COMMITS_LIMIT),
    commit_count: (facts.commits ?? []).length,
    patches: patchNames.slice(0, PATCHES_LIMIT).map((p) => `${runDir}/packets/${p}`),
    run_dir: runDir,
  };

  return {
    run_id: runId,
    outcome,
    verdict,
    merged,
    tasks,
    produced,
    integration,
    recovery,
    ...(failure !== undefined
      ? { failure: { failure_class: failure.failure_class, ...(failure.message !== undefined ? { message: failure.message } : {}), plain_reason: plainReasonOf(failure.failure_class, failure.message) } }
      : {}),
    next,
  };
}

// ----- renderers -----

/** R13.1: the one line that names a task whose plan setup failed (the worker ran anyway). */
function setupLine(t: TaskReport): string {
  return `environment setup failed in ${t.id}: ${clip(t.setup_failed?.command ?? "", 100)} (the worker ran anyway)`;
}

/** R13.1: the one line that says a passed task's own check could not run, and why. */
function verificationNotRunLine(t: TaskReport): string {
  return `${t.id} passed but its check could not run: ${clip(t.verification_not_run ?? "", 160)}`;
}

function taskBlock(t: TaskReport): string[] {
  const title = t.title !== undefined ? clip(t.title, 40) : "";
  const lines = [`  ${t.id.padEnd(5)}${t.state.padEnd(13)}${title}`.replace(/\s+$/, "")];
  if (t.files_changed.length > 0) {
    const more = t.files_changed_total - Math.min(t.files_changed.length, 3);
    const shown = t.files_changed.slice(0, 3).join(", ");
    lines.push(`        files:  ${shown}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  if (t.plain_reason !== undefined) {
    const command = t.failing_command !== undefined ? ` (${clip(t.failing_command, 80)})` : "";
    const message = t.message !== undefined && t.message !== t.plain_reason ? ` - ${clip(t.message, 120)}` : "";
    lines.push(`        why:    ${t.plain_reason}${command}${message}`);
  }
  if (t.patch_path !== undefined) lines.push(`        patch:  ${t.patch_path}`);
  for (const line of (t.output_tail ?? []).slice(-3)) lines.push(`        output: ${clip(line, 120)}`);
  return lines;
}

/**
 * The text form of a run report: compact, plain, and never contradicting itself. It is the failure block of the
 * end-of-run summary, of `status` for a run that is not running, and of `resume` before it continues.
 */
export function renderReportText(report: RunReport): string {
  const lines: string[] = [report.verdict];
  if (report.tasks.length > 0 && report.outcome !== "planned") {
    lines.push("Per task:");
    for (const t of report.tasks) lines.push(...taskBlock(t));
  }
  for (const t of report.tasks) {
    if (t.setup_failed !== undefined) lines.push(setupLine(t));
    if (t.verification_not_run !== undefined) lines.push(verificationNotRunLine(t));
  }
  if (report.integration.result === "failed" || report.integration.result === "passed") {
    if (report.integration.result === "failed") {
      lines.push(`Final check: failed${report.integration.command !== undefined ? `: ${clip(report.integration.command, 100)}` : ""}`);
    } else if (report.integration.repaired !== undefined) {
      lines.push(`Final check: passed after ${pluralWord(report.integration.repaired, "repair attempt", "repair attempts")}`);
    }
    if (report.integration.output_tail.length > 0) {
      lines.push("Output:");
      for (const line of report.integration.output_tail) lines.push(`  ${clip(line, 160)}`);
    }
  }
  if (report.recovery.repair !== undefined && !report.recovery.repair.passed) {
    const r = report.recovery.repair;
    const reason = r.reason !== undefined ? ` (${r.reason})` : "";
    lines.push(`Repair:     ${r.attempts} ${r.attempts === 1 ? "attempt" : "attempts"}, none passed${reason}`);
    for (const outcome of r.outcomes) lines.push(`            ${outcome}`);
  }
  lines.push("Produced:");
  if (report.produced.branch !== undefined) {
    const commits = report.produced.commit_count > 0 ? ` (${pluralWord(report.produced.commit_count, "commit", "commits")} above ${report.produced.base_branch ?? "the base"})` : "";
    lines.push(`  branch:  ${report.produced.branch}${commits}`);
  } else {
    lines.push("  branch:  none (the run ended before it made its branch)");
  }
  // A task's own patch is named under its task; the produced list names the rest.
  if (!report.tasks.some((t) => t.patch_path !== undefined)) {
    for (const patch of report.produced.patches) lines.push(`  patch:   ${patch}`);
  }
  lines.push(`  Drafts and logs: ${report.produced.run_dir}/`);
  const r = report.recovery;
  const recoveryParts = [
    r.fixes > 0 ? pluralWord(r.fixes, "fix", "fixes") : "",
    r.l1_replans + r.l2_replans > 0 ? pluralWord(r.l1_replans + r.l2_replans, "replan", "replans") : "",
    r.repairs > 0 ? pluralWord(r.repairs, "repair attempt", "repair attempts") : "",
  ].filter((x) => x !== "");
  if (recoveryParts.length > 0) lines.push(`Recovery:   ${recoveryParts.join(", ")}`);
  if (report.failure !== undefined) {
    // The Reason line keeps the raw class and message: callers have always read it that way.
    const label = report.failure.failure_class === "internal_error" ? "internal error" : report.failure.failure_class;
    lines.push(`Reason:     ${label}${report.failure.message ? `: ${report.failure.message}` : ""}`);
  }
  report.next.forEach((line, i) => {
    if (i === 0) {
      lines.push(report.outcome === "interrupted" ? `Interrupted. Resume with: ${line}` : `Next:       ${line}`);
    } else {
      lines.push(`            ${line}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

/** The Markdown form written to REPORT.md in the run directory. Same content as the text form, with a full output tail. */
export function renderReportMarkdown(report: RunReport): string {
  const out: string[] = [`# Run ${report.run_id}: ${report.outcome.replace(/_/g, " ")}`, "", report.verdict, ""];
  if (report.tasks.length > 0) {
    out.push("## Tasks", "");
    for (const t of report.tasks) {
      const title = t.title !== undefined ? `: ${t.title}` : "";
      out.push(`- **${t.id}** ${t.state}${title}`);
      if (t.files_changed.length > 0) out.push(`  - files: ${t.files_changed.join(", ")}${t.files_changed_total > t.files_changed.length ? ` (${t.files_changed_total} in total)` : ""}`);
      if (t.plain_reason !== undefined) out.push(`  - why: ${t.plain_reason}${t.message !== undefined && t.message !== t.plain_reason ? ` (${t.message})` : ""}`);
      if (t.failing_command !== undefined) out.push(`  - command: \`${t.failing_command}\``);
      if (t.patch_path !== undefined) out.push(`  - patch: \`${t.patch_path}\``);
      if (t.setup_failed !== undefined) out.push(`  - ${setupLine(t)}`);
      if (t.verification_not_run !== undefined) out.push(`  - ${verificationNotRunLine(t)}`);
      if (t.output_tail !== undefined && t.output_tail.length > 0) {
        out.push("  - output:", "", "    ```", ...t.output_tail.map((l) => `    ${l}`), "    ```");
      }
    }
    out.push("");
  }
  if (report.integration.result !== "none") {
    out.push("## Final check", "", `- result: ${report.integration.result}`);
    if (report.integration.command !== undefined) out.push(`- command: \`${report.integration.command}\``);
    if (report.integration.reason !== undefined) out.push(`- reason: ${report.integration.reason}`);
    if (report.integration.output_tail.length > 0) out.push("", "```", ...report.integration.output_tail, "```");
    out.push("");
  }
  out.push("## Produced", "");
  out.push(`- branch: ${report.produced.branch ?? "none"}${report.produced.base_branch !== undefined ? ` (base ${report.produced.base_branch})` : ""}`);
  for (const c of report.produced.commits) out.push(`- commit: ${c}`);
  for (const p of report.produced.patches) out.push(`- patch: \`${p}\``);
  out.push(`- run directory: \`${report.produced.run_dir}/\``, "");
  const r = report.recovery;
  out.push("## Recovery", "", `- fixes: ${r.fixes}`, `- L1 replans: ${r.l1_replans}`, `- L2 replans: ${r.l2_replans}`, `- repair attempts: ${r.repairs}`);
  if (r.stopped_because !== undefined) out.push(`- stopped because: ${r.stopped_because}`);
  out.push("");
  if (report.failure !== undefined) out.push("## Reason", "", `${report.failure.failure_class}${report.failure.message ? `: ${report.failure.message}` : ""}`, "");
  out.push("## Next", "");
  for (const line of report.next) out.push(`- \`${line}\``);
  return `${out.join("\n")}\n`;
}
