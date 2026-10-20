import type { RunSummary } from "../contracts/index.js";

// Where a run's work landed, reported in the summary of every format (R7.4). The git facts
// come from src/git/landing.ts; this file only shapes them.

/** File names the text summary lists. */
export const TEXT_FILES_LIMIT = 10;
/** File names the json and stream-json summaries carry; files_changed_total counts all. */
export const JSON_FILES_LIMIT = 50;

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
    next.push(`substrate resume ${runId}`);
  }
  return {
    ...summary,
    merged: facts.merged,
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
