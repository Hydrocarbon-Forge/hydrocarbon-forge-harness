import type { RunSummary } from "../contracts/index.js";
import { failedRunNext } from "./failed-run.js";

// Where a run's work landed, reported in the summary of every format (R7.4). The git facts
// come from src/git/landing.ts; this file only shapes them.

/** File names the text summary lists. */
export const TEXT_FILES_LIMIT = 10;
/** File names the json and stream-json summaries carry; files_changed_total counts all. */
export const JSON_FILES_LIMIT = 50;

/** Why a finished run stays on its branch when the caller turned merging off (R10.1). */
export const MERGE_TURNED_OFF_REASON = "not merged: merging was turned off";

/** The branch a run started on, from its run.created event; undefined for a run without one (before R10.1). */
export function startBranchOf(events: readonly EventLike[]): string | undefined {
  const created = events.find((e) => e.type === "run.created");
  const base = (created?.data as { base_branch?: unknown } | undefined)?.base_branch;
  return typeof base === "string" ? base : undefined;
}

export interface LandingFacts {
  /** The run's work is in the checked-out history (the working tree has it). */
  merged: boolean;
  /** The checked-out branch: where `substrate merge` puts the work. */
  base_branch: string;
  /** Every file the run changes, in git order. */
  files: string[];
  /** The run itself did not finish with exit 0 (before any merge). */
  runFailed: boolean;
  /** The run paused for answers; its resume line is printed by the formatter, not `next`. */
  needsInput: boolean;
  /** The failing event's class and message, when the run failed on one. */
  failure?: { failure_class: string; message?: string; output_tail?: string };
  /** The command that continues the run, when it is not plain `substrate resume <id>` (R8.2). */
  resumeCommand?: string;
  /** Why a finished run did not land (R8.2), shown in the Result block. */
  notMergedReason?: string;
  /**
   * A failed run whose run branch holds a passed task and whose plan has integration verify:
   * `merge --partial` can land it (R8.2, known issue 41).
   */
  partialLandable?: boolean;
  /** The final check's outcome (R12.2), from verificationOf; absent when the run recorded none. */
  verification?: Verification;
  /** R12.4: the repair attempts of the final check's last round, from repairOf; absent when none ran. */
  repair?: RepairFacts;
  /** R12.4: the attempt that passed the final check, when a repair did (from integration.finished). */
  repaired?: number;
}

/** The repair attempts of a failed final check (R12.4): how many ran, whether one passed, and each one's outcome. */
export interface RepairFacts {
  attempts: number;
  passed: boolean;
  /** The reason the last attempt did not pass; absent when one passed. */
  reason?: string;
  /** One line per attempt: `attempt <n>: passed` or `attempt <n>: rejected: <reason>`. */
  outcomes: string[];
}

/**
 * The repair attempts of the run's last final check (R12.4), read from its events: from the last round's first
 * attempt to the end of the log. Undefined when no repair ran.
 */
export function repairOf(events: readonly EventLike[]): RepairFacts | undefined {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i].data as Record<string, unknown> | null;
    if (events[i].type === "integration.repair.started" && data?.attempt === 1) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  let attempts = 0;
  let passed = false;
  let reason: string | undefined;
  const outcomes: string[] = [];
  for (let i = start; i < events.length; i++) {
    const { type, data: raw } = events[i];
    const data = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (type === "integration.repair.started" && typeof data.attempt === "number") {
      attempts = Math.max(attempts, data.attempt);
    }
    if (type === "integration.repair.finished") {
      const n = typeof data.attempt === "number" ? data.attempt : 0;
      if (data.passed === true) {
        passed = true;
        reason = undefined;
        outcomes.push(`attempt ${n}: passed`);
      } else {
        reason = typeof data.reason === "string" ? data.reason : "no reason recorded";
        outcomes.push(`attempt ${n}: rejected: ${reason}`);
      }
    }
  }
  return { attempts, passed, ...(reason !== undefined ? { reason } : {}), outcomes };
}

/** The attempt that passed the final check, from the run's last integration.finished (R12.4); undefined when none was repaired. */
export function repairedOf(events: readonly EventLike[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "integration.finished") continue;
    const repaired = (events[i].data as { repaired?: unknown } | null)?.repaired;
    return typeof repaired === "number" ? repaired : undefined;
  }
  return undefined;
}

/** The final check's outcome (R12.2): a verdict, and for a check that could not run, why. */
export interface Verification {
  verification: "passed" | "failed" | "skipped" | "not_run";
  note?: string;
}

/**
 * The final check's outcome, read from the run's events (R12.2): the latest one the run recorded,
 * or undefined when the run recorded none (a failed task, or a plan with no integration verify).
 */
export function verificationOf(events: readonly EventLike[]): Verification | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const { type, data } = events[i];
    const record = (data !== null && typeof data === "object" ? data : {}) as Record<string, unknown>;
    if (type === "integration.skipped") return { verification: "skipped" };
    if (type === "integration.could_not_run") {
      return { verification: "not_run", note: typeof record.reason === "string" ? record.reason : "" };
    }
    if (type === "integration.failed" || type === "bisect.culprit") return { verification: "failed" };
    if (type === "integration.finished") return { verification: record.passed === true ? "passed" : "failed" };
  }
  return undefined;
}

/** The suggested run budget for a resume after a budget stop: twice the spend or the cap plus the spend, to the cent. */
export function suggestedBudgetUsd(spent: number, cap: number): number {
  const raw = Math.max(2 * cap, spent + cap);
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

/**
 * The command that continues a run stopped by its run budget (R8.2): the resume names a higher
 * budget, because the spend already recorded counts against the same cap.
 */
export function budgetResumeCommand(runId: string, spent: number, cap: number): string {
  return `substrate resume ${runId} --max-budget-usd ${suggestedBudgetUsd(spent, cap).toFixed(2)}`;
}

/**
 * The reason line of a run stopped by its budget (R8.2): how much was spent, and what each task
 * was doing when the stop came. `tasks` are the summary's task states.
 */
export function budgetStopMessage(spent: number, cap: number, tasks: Record<string, { state: string }>): string {
  return `spent $${spent.toFixed(4)} of the $${cap.toFixed(2)} run budget${taskStopTail(tasks)}`;
}

/**
 * The task list at the end of a stop's reason line (R8.2, R11.2): `; <task> passed, <task> interrupted, ...`,
 * or nothing when the run has no task yet.
 */
function taskStopTail(tasks: Record<string, { state: string }>): string {
  const label = (state: string): string => {
    if (state === "PASSED" || state === "MERGING" || state === "MERGED") return "passed";
    if (state === "FAILED") return "failed";
    if (state === "SKIPPED") return "skipped";
    if (state === "PENDING" || state === "READY") return "not started";
    return "interrupted";
  };
  const parts = Object.entries(tasks).map(([id, t]) => `${id} ${label(t.state)}`);
  return parts.length > 0 ? `; ${parts.join(", ")}` : "";
}

/** The reason line of a run stopped by its wall-clock limit (R11.2): the limit, and what each task was doing. */
export function timeoutStopMessage(limitS: number, tasks: Record<string, { state: string }>): string {
  return `the run reached its ${limitS}s time limit${taskStopTail(tasks)}`;
}

/**
 * The command that continues a run stopped by its time limit (R11.2): the resume names a longer limit, because
 * a resume starts a fresh clock. Twice the limit, in whole seconds, as `--timeout` requires.
 */
export function timeoutResumeCommand(runId: string, limitS: number): string {
  return `substrate resume ${runId} --timeout ${Math.ceil(2 * limitS)}`;
}

interface EventLike {
  type: string;
  data?: unknown;
}

/** The last event that names a failure_class (a task.failed, usually), or undefined. */
export function failureOf(
  events: readonly EventLike[],
): { failure_class: string; message?: string; output_tail?: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i].data;
    if (data === null || typeof data !== "object") continue;
    const record = data as Record<string, unknown>;
    if (typeof record.failure_class !== "string") continue;
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.detail === "string"
          ? record.detail
          : undefined;
    // A failed final check carries the tail of its output (integration.failed, R12.2).
    const outputTail = typeof record.output_tail === "string" ? record.output_tail : undefined;
    return {
      failure_class: record.failure_class,
      ...(message !== undefined ? { message } : {}),
      ...(outputTail !== undefined ? { output_tail: outputTail } : {}),
    };
  }
  return undefined;
}

/** The summary with the landing fields added. `next` lists the commands a caller may run. */
export function withLanding(summary: RunSummary, facts: LandingFacts): RunSummary {
  const runId = summary.run_id;
  const next: string[] = [];
  if (!facts.runFailed && !facts.merged) {
    next.push(`substrate merge ${runId}`);
  }
  if (facts.runFailed && !facts.needsInput) {
    // R10.4: a failed run is resumed; its next commands are the resume, the partial landing and a new request.
    if (summary.status === "failed") {
      // Every task merged and the final check failed: `merge --partial` would rerun that check, so it is not offered.
      const verifyOnly = summary.failure_class === "integration_failed" && Object.values(summary.tasks ?? {}).every((t) => t.state === "PASSED");
      next.push(
        ...failedRunNext(runId, {
          partialLandable: facts.partialLandable === true && !verifyOnly,
          planningFailed: Object.keys(summary.tasks ?? {}).length === 0,
          verifyOnly,
          internalError: summary.failure_class === "internal_error",
        }),
      );
    } else {
      next.push(facts.resumeCommand ?? `substrate resume ${runId}`);
    }
  }
  return {
    ...summary,
    merged: facts.merged,
    ...(facts.notMergedReason !== undefined ? { not_merged_reason: facts.notMergedReason } : {}),
    ...(facts.verification !== undefined
      ? {
          verification: facts.verification.verification,
          ...(facts.verification.note !== undefined ? { verification_note: facts.verification.note } : {}),
        }
      : {}),
    ...(facts.repair !== undefined ? { repair: facts.repair } : {}),
    ...(facts.repaired !== undefined ? { repaired: facts.repaired } : {}),
    base_branch: facts.base_branch,
    files_changed: facts.files.slice(0, JSON_FILES_LIMIT),
    files_changed_total: facts.files.length,
    next,
    // A failed run always names a class and a message; the pause reason or the status stands in
    // when the run failed without a failing event.
    ...(facts.runFailed
      ? {
          drafts_dir: `.substrate/runs/${runId}`,
          failure_class: facts.failure?.failure_class ?? summary.pause_reason ?? summary.status,
          message: facts.failure?.message ?? "",
          ...(facts.failure?.output_tail !== undefined ? { output_tail: facts.failure.output_tail } : {}),
        }
      : {}),
  };
}
