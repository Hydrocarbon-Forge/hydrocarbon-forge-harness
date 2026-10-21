import type { RunSummary } from "../contracts/index.js";

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
  failure?: { failure_class: string; message?: string };
  /** The command that continues the run, when it is not plain `substrate resume <id>` (R8.2). */
  resumeCommand?: string;
  /** Why a finished run did not land (R8.2), shown in the Result block. */
  notMergedReason?: string;
  /**
   * A failed run whose run branch holds a passed task and whose plan has integration verify:
   * `merge --partial` can land it (R8.2, known issue 41).
   */
  partialLandable?: boolean;
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
  const label = (state: string): string => {
    if (state === "PASSED" || state === "MERGING" || state === "MERGED") return "passed";
    if (state === "FAILED") return "failed";
    if (state === "SKIPPED") return "skipped";
    if (state === "PENDING" || state === "READY") return "not started";
    return "interrupted";
  };
  const parts = Object.entries(tasks).map(([id, t]) => `${id} ${label(t.state)}`);
  const tail = parts.length > 0 ? `; ${parts.join(", ")}` : "";
  return `spent $${spent.toFixed(4)} of the $${cap.toFixed(2)} run budget${tail}`;
}

interface EventLike {
  type: string;
  data?: unknown;
}

/** The last event that names a failure_class (a task.failed, usually), or undefined. */
export function failureOf(events: readonly EventLike[]): { failure_class: string; message?: string } | undefined {
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
    return { failure_class: record.failure_class, ...(message !== undefined ? { message } : {}) };
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
    // A failed run is not resumable (known issue 41): its only next command is the partial landing.
    if (summary.status === "failed") {
      if (facts.partialLandable === true) next.push(`substrate merge ${runId} --partial`);
    } else {
      next.push(facts.resumeCommand ?? `substrate resume ${runId}`);
    }
  }
  return {
    ...summary,
    merged: facts.merged,
    ...(facts.notMergedReason !== undefined ? { not_merged_reason: facts.notMergedReason } : {}),
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
        }
      : {}),
  };
}
