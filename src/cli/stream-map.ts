import type { EventType } from "../contracts/events.js";

// Stream-json names for engine events. The engine event names are canonical
// (DECISIONS.md); this table is the single place where stream-json names are
// chosen. Identity for every catalog member except usage.recorded, which has
// streamed as "usage" since before the catalog existed and callers rely on it.
export const STREAM_TYPE: Record<EventType, string> = {
  "run.created": "run.created",
  "run.routed": "run.routed",
  "run.paused": "run.paused",
  "run.resumed": "run.resumed",
  "run.finished": "run.finished",
  "run.budget.warning": "run.budget.warning",
  "run.budget.exceeded": "run.budget.exceeded",
  "plan.started": "plan.started",
  "plan.produced": "plan.produced",
  "plan.lint": "plan.lint",
  "plan.approved": "plan.approved",
  "plan.rejected": "plan.rejected",
  "plan.ready": "plan.ready",
  "contracts.committed": "contracts.committed",
  "setup.done": "setup.done",
  "batch.started": "batch.started",
  "batch.merged": "batch.merged",
  "task.ready": "task.ready",
  "task.worktree.created": "task.worktree.created",
  "task.session.started": "task.session.started",
  "task.session.ended": "task.session.ended",
  "task.scope.checked": "task.scope.checked",
  "scope.checked": "scope.checked",
  "task.verify.started": "task.verify.started",
  "task.verify.finished": "task.verify.finished",
  "task.healing": "task.healing",
  "task.passed": "task.passed",
  "task.merged": "task.merged",
  "task.blocked": "task.blocked",
  "task.failed": "task.failed",
  "task.replanned": "task.replanned",
  "tasks.invalidated": "tasks.invalidated",
  "replan.started": "replan.started",
  "replan.finished": "replan.finished",
  "replan.l2": "replan.l2",
  "integration.started": "integration.started",
  "integration.finished": "integration.finished",
  "integration.failed": "integration.failed",
  "bisect.started": "bisect.started",
  "bisect.culprit": "bisect.culprit",
  "merge.conflict": "merge.conflict",
  "usage.recorded": "usage",
  "rate_limit.backoff": "rate_limit.backoff",
};

export function streamTypeFor(type: string): string {
  const mapped = (STREAM_TYPE as Record<string, string | undefined>)[type];
  return mapped ?? "unknown";
}
