import { z, ZodError } from "zod";

import {
  FailureClass,
  PauseReason,
  UsageRecord,
  RoleName,
} from "./index.js";
import type { Question } from "./index.js";

/**
 * The engine event catalog. Every engine event is defined exactly once here as a
 * member of a zod discriminated union on `type`, with a strict envelope and a
 * strict `data` shape. Shapes follow SUBSTRATE-PLAN Appendix D, the DECISIONS
 * additions, and the shapes the emit sites in src/engine actually pass.
 */

function member<T extends string>(type: T, data: z.ZodTypeAny) {
  return z
    .object({
      v: z.literal(1),
      seq: z.number().int(),
      ts: z.string(),
      // The engine accepts run ids produced by pre-created run directories that
      // pre-date the RunId regex (see protected scenario fixtures), so the
      // envelope validates the id as a string here; the RunId type is enforced
      // where new run ids are generated.
      run_id: z.string(),
      type: z.literal(type),
      data,
    })
    .strict();
}

export const RunCreatedEvent = member(
  "run.created",
  z
    .object({
      run_id: z.string().optional(),
      prompt: z.string().optional(),
      mode: z.string().optional(),
      permission_mode: z.string().optional(),
      requested_roles: z.record(z.string(), z.unknown()).optional(),
      // The branch checked out when the run started: the only branch its work lands on (R10.1).
      base_branch: z.string().optional(),
      // The landing choice in effect at creation (R10.3): a resume uses it unless --merge or --no-merge is given again.
      merge: z.boolean().optional(),
      // The worker count in effect at creation (R10.3): a resume uses it unless --concurrency is given again.
      concurrency: z.number().int().optional(),
      // R11.1: the run budget in effect at creation (the flag, the request or the setting). A resume uses it
      // unless --max-budget-usd is given again; status and watch show it. null: no run cap was set.
      max_budget_usd: z.number().nullable().optional(),
      // R11.2: the wall-clock limit in seconds in effect at creation, null when none is set. A resume uses it
      // unless --timeout is given again; the run stops with reason timeout when it is reached.
      time_limit_s: z.number().nullable().optional(),
      // R11.1: the run-level lists the run was started with (flags or request), reused by a resume.
      verify: z.array(z.string()).optional(),
      context: z.array(z.string()).optional(),
      permissions: z
        .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
        .optional(),
      sandbox: z.boolean().optional(),
      history_all: z.boolean().optional(),
    })
    .strict()
);

export const RunRoutedEvent = member(
  "run.routed",
  z
    .object({
      mode: z.enum(["solo", "plan"]),
      // Why the route was chosen: the router's rationale in auto, or the explicit mode.
      rationale: z.string().optional(),
    })
    .strict()
);

const QuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  default: z.string().optional(),
}).strict();

export const RunPausedEvent = member(
  "run.paused",
  z
    .object({
      reason: PauseReason,
      questions_path: z.string().optional(),
      session_id: z.string().optional(),
      questions: z.array(QuestionSchema).optional(),
      // R11.2: the wall-clock limit that was reached, for reason timeout.
      time_limit_s: z.number().optional(),
    })
    .strict()
);

export const RunResumedEvent = member(
  "run.resumed",
  z
    .object({
      answers: z
        .array(
          z
            .object({
              id: z.string(),
              text: z.string(),
            })
            .strict()
        )
        .optional(),
      // R11.1: the run budget the resume uses (null: none); a later resume without the flag keeps it.
      max_budget_usd: z.number().nullable().optional(),
      // R11.2: the wall-clock limit the resume uses (null: none); a later resume without --timeout keeps it.
      time_limit_s: z.number().nullable().optional(),
    })
    .strict()
);

/**
 * R10.4 (known issue 41, reversed): a run that did not finish is reopened by `substrate resume`. `planning`
 * runs plan again; `setup` runs setup again; `tasks` retries the failed tasks (`failed_tasks`, a new
 * generation), returns the skipped dependents to the queue (`skipped_tasks`), and keeps the merged ones (`kept_tasks`).
 */
export const RunReopenedEvent = member(
  "run.reopened",
  z
    .object({
      // plan_review: the engine reopens a planned run when `resume` accepts the plan the person reviewed (R10.5).
      reason: z.enum(["planning", "setup", "tasks", "plan_review"]),
      failed_tasks: z.array(z.string()).optional(),
      skipped_tasks: z.array(z.string()).optional(),
      kept_tasks: z.array(z.string()).optional(),
      // R10.5: the run-directory name (drafts-<n>) an abandoned planning draft was moved to.
      draft_dir: z.string().optional(),
      // R11.3: a planning reopen whose planning round stopped before any plan existed (no plan was produced or refused).
      planning_cut_short: z.boolean().optional(),
      // R11.1: the run budget the resume uses (null: none); a later resume without the flag keeps it.
      max_budget_usd: z.number().nullable().optional(),
      // R11.2: the wall-clock limit the resume uses (null: none); a later resume without --timeout keeps it.
      time_limit_s: z.number().nullable().optional(),
    })
    .strict()
);

export const RunFinishedEvent = member(
  "run.finished",
  z
    .object({
      exit_code: z.number().int(),
      status: z.string().optional(),
      reason: z.string().optional(),
      files: z.array(z.string()).optional(),
      failed_tasks: z.array(z.string()).optional(),
      // R9.1: set when an unexpected exception ended the run (failure_class internal_error).
      failure_class: z.string().optional(),
      message: z.string().max(2000).optional(),
    })
    .strict()
);

export const RunBudgetWarningEvent = member(
  "run.budget.warning",
  z
    .object({
      cost_usd: z.number().optional(),
      max_usd: z.number().optional(),
      // The same warning for the run token budget (R3.4).
      tokens: z.number().optional(),
      max_tokens: z.number().optional(),
    })
    .strict()
);

export const RunBudgetExceededEvent = member(
  "run.budget.exceeded",
  z
    .object({
      cost_usd: z.number().optional(),
      max_usd: z.number().optional(),
      tokens: z.number().optional(),
      max_tokens: z.number().optional(),
    })
    .strict()
);

export const PlanStartedEvent = member("plan.started", z.object({}).strict());

// One entry of a plan's task list. id and spec are the manifest's fields; title, class
// and depends_on come from the task spec's frontmatter and are there so progress
// output can show the plan without reading files.
export const PlanTaskEntry = z
  .object({
    id: z.string(),
    spec: z.string().optional(),
    title: z.string().optional(),
    class: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
  })
  .passthrough();

export const PlanProducedEvent = member(
  "plan.produced",
  z
    .object({
      manifest: z.unknown().optional(),
      tasks: z.array(PlanTaskEntry).optional(),
      commit_sha: z.string().optional(),
      // R10.5: where the accepted plan came from. `draft` is a complete draft a resume reused (the planner did not run).
      source: z.enum(["planner", "draft", "review"]).optional(),
    })
    .strict()
);

export const PlanLintEvent = member(
  "plan.lint",
  z
    .object({
      valid: z.boolean().optional(),
      errors: z.number().optional(),
      diagnostics: z.array(z.unknown()).optional(),
    })
    .strict()
);

export const PlanApprovedEvent = member("plan.approved", z.object({}).strict());

export const PlanRejectedEvent = member(
  "plan.rejected",
  z
    .object({
      reason: z.string().optional(),
      diagnostics: z.array(z.unknown()).optional(),
    })
    .strict()
);

// A planner attempt whose output was refused, before the format retry. Not plan.rejected:
// that event ends the plan in the reducer. Errors are capped at 5 items of 300 characters.
export const PlanFormatRejectedEvent = member(
  "plan.format_rejected",
  z
    .object({
      attempt: z.number().int(),
      max_attempts: z.number().int(),
      errors: z.array(z.string().max(300)).max(5),
    })
    .strict()
);

export const PlanReadyEvent = member("plan.ready", z.object({}).strict());

export const ContractsCommittedEvent = member(
  "contracts.committed",
  z.object({ commit_sha: z.string().optional(), note: z.string().optional() }).strict()
);

export const SetupDoneEvent = member(
  "setup.done",
  z
    .object({
      tasks: z
        .array(
          z
            .object({
              id: z.string(),
              depends_on: z.array(z.string()),
              write: z.array(z.string()),
              create: z.array(z.string()),
            })
            .strict()
        )
        .optional(),
    })
    .strict()
);

export const BatchStartedEvent = member(
  "batch.started",
  z.object({ batch: z.array(z.string()).optional() }).strict()
);

export const BatchMergedEvent = member(
  "batch.merged",
  z
    .object({
      batch: z.array(z.string()),
      checkpoint_ref: z.string(),
    })
    .strict()
);

export const TaskReadyEvent = member(
  "task.ready",
  z
    .object({
      task_id: z.string(),
      resumed: z.boolean().optional(),
    })
    .strict()
);

export const TaskWorktreeCreatedEvent = member(
  "task.worktree.created",
  z
    .object({ task_id: z.string(), path: z.string().optional() })
    .strict()
);

export const TaskSessionStartedEvent = member(
  "task.session.started",
  z
    .object({
      task_id: z.string(),
      generation: z.number().int(),
      attempt: z.number().int(),
      session_id: z.string(),
      // The route the attempt runs on, when the engine knows it.
      backend: z.string().optional(),
      model: z.string().optional(),
    })
    .strict()
);

export const TaskSessionEndedEvent = member(
  "task.session.ended",
  z
    .object({
      task_id: z.string(),
      generation: z.number().optional(),
      attempt: z.number().optional(),
    })
    .strict()
);

export const TaskScopeCheckedEvent = member(
  "task.scope.checked",
  z
    .object({
      task_id: z.string(),
      generation: z.number().int(),
      attempt: z.number().int(),
      ok: z.boolean(),
      violations: z.array(z.string()).optional(),
      protected_modified: z.array(z.string()).optional(),
    })
    .strict()
);

// Legacy alias of task.scope.checked, kept for the protected scenario suite
// that asserts the old name; observe-only.
export const ScopeCheckedEvent = member(
  "scope.checked",
  z
    .object({
      task_id: z.string(),
      generation: z.number().int(),
      attempt: z.number().int(),
      ok: z.boolean(),
      violations: z.array(z.string()).optional(),
      protected_modified: z.array(z.string()).optional(),
    })
    .strict()
);

export const TaskVerifyStartedEvent = member(
  "task.verify.started",
  z
    .object({
      task_id: z.string(),
      generation: z.number().int(),
      attempt: z.number().int(),
    })
    .strict()
);

export const TaskVerifyFinishedEvent = member(
  "task.verify.finished",
  z
    .object({
      task_id: z.string(),
      generation: z.number().int(),
      attempt: z.number().int(),
      passed: z.boolean(),
      failure_class: FailureClass.optional(),
      // On a failed verify: the first failing command and one line of its output
      // (at most 300 characters).
      failed_command: z.string().optional(),
      failed_output: z.string().max(300).optional(),
    })
    .strict()
);

export const TaskHealingEvent = member(
  "task.healing",
  z
    .object({
      task_id: z.string(),
      generation: z.number().int(),
      attempt: z.number().int(),
      session_id: z.string().optional(),
      failures: z.string(),
    })
    .strict()
);

export const TaskPassedEvent = member(
  "task.passed",
  z
    .object({
      task_id: z.string(),
      generation: z.number().optional(),
      attempt: z.number().optional(),
    })
    .strict()
);

export const TaskMergedEvent = member(
  "task.merged",
  z.object({ task_id: z.string() }).strict()
);

export const TaskBlockedEvent = member(
  "task.blocked",
  z
    .object({
      task_id: z.string(),
      dependents: z.array(z.string()).optional(),
    })
    .strict()
);

/**
 * A PENDING task whose dependency failed or was skipped: it never runs (R8.1). `depends_on`
 * lists the direct dependencies that failed (BLOCKED) or were skipped (ABANDONED).
 */
export const TaskSkippedEvent = member(
  "task.skipped",
  z
    .object({
      task_id: z.string(),
      reason: z.literal("dependency_failed"),
      failed: z.array(z.string()),
      skipped: z.array(z.string()),
    })
    .strict()
);

export const TaskFailedEvent = member(
  "task.failed",
  z
    .object({
      task_id: z.string().optional(),
      generation: z.number().optional(),
      attempt: z.number().optional(),
      failure_class: FailureClass,
      can_replan: z.boolean().optional(),
      detail: z.string().optional(),
      // One line, at most 2000 characters: the reason the failure happened.
      message: z.string().max(2000).optional(),
    })
    .strict()
);

export const TaskReplannedEvent = member(
  "task.replanned",
  z.object({ task_id: z.string(), generation: z.number().int() }).strict()
);

export const TasksInvalidatedEvent = member(
  "tasks.invalidated",
  z.object({ task_ids: z.array(z.string()) }).strict()
);

export const ReplanStartedEvent = member(
  "replan.started",
  z
    .object({
      task_id: z.string().optional(),
      // Generation the replan produces, the model tier the ladder routed to, and the
      // reason this replan was entered (first time, or the L1 output that escalated).
      generation: z.number().int().optional(),
      target_tier: z.string().optional(),
      reason: z.string().optional(),
    })
    .strict()
);

export const ReplanL2Event = member(
  "replan.l2",
  z
    .object({
      task_id: z.string().optional(),
      generation: z.number().int().optional(),
      // Tasks the amendment invalidated; already-merged tasks are never in it.
      invalidated: z.array(z.string()).optional(),
    })
    .strict()
);

export const ReplanFinishedEvent = member(
  "replan.finished",
  z.object({ task_id: z.string(), generation: z.number().int() }).strict()
);

export const IntegrationStartedEvent = member(
  "integration.started",
  // base_verify_passed: false when integration_verify did not pass on the base commit (R3.6
  // behaviour 8, advisory). Absent when it passed there or the base was not checked.
  z.object({ base_verify_passed: z.boolean().optional() }).strict()
);

export const IntegrationFinishedEvent = member(
  "integration.finished",
  z.object({ passed: z.boolean() }).strict()
);

export const IntegrationFailedEvent = member(
  "integration.failed",
  // base is written by runs before R7.11 (the base check failed the run); R7.11 writes the rest:
  // the failing command, its exit code (absent when it timed out) and a capped output tail.
  z
    .object({
      base: z.boolean().optional(),
      failure_class: FailureClass.optional(),
      message: z.string().max(2000).optional(),
      command: z.string().max(500).optional(),
      exit_code: z.number().int().optional(),
      output_tail: z.string().max(2000).optional(),
    })
    .strict()
);

export const BisectStartedEvent = member("bisect.started", z.object({}).strict());

export const BisectCulpritEvent = member(
  "bisect.culprit",
  z.object({ culprit_task_id: z.string() }).strict()
);

export const MergeConflictEvent = member(
  "merge.conflict",
  z
    .object({
      task_id: z.string(),
      conflict_files: z.array(z.string()),
    })
    .strict()
);

export const UsageRecordedEvent = member(
  "usage.recorded",
  z
    .object({
      record: UsageRecord,
      role: RoleName,
      task_id: z.string().optional(),
      generation: z.number().optional(),
      attempt: z.number().optional(),
      class: z.string().optional(),
    })
    .strict()
);

export const RateLimitBackoffEvent = member(
  "rate_limit.backoff",
  z.object({ task_id: z.string(), concurrency: z.number() }).strict()
);

export const EngineEventV1 = z.discriminatedUnion("type", [
  RunCreatedEvent,
  RunRoutedEvent,
  RunPausedEvent,
  RunResumedEvent,
  RunReopenedEvent,
  RunFinishedEvent,
  RunBudgetWarningEvent,
  RunBudgetExceededEvent,
  PlanStartedEvent,
  PlanProducedEvent,
  PlanLintEvent,
  PlanApprovedEvent,
  PlanRejectedEvent,
  PlanFormatRejectedEvent,
  PlanReadyEvent,
  ContractsCommittedEvent,
  SetupDoneEvent,
  BatchStartedEvent,
  BatchMergedEvent,
  TaskReadyEvent,
  TaskWorktreeCreatedEvent,
  TaskSessionStartedEvent,
  TaskSessionEndedEvent,
  TaskScopeCheckedEvent,
  ScopeCheckedEvent,
  TaskVerifyStartedEvent,
  TaskVerifyFinishedEvent,
  TaskHealingEvent,
  TaskPassedEvent,
  TaskMergedEvent,
  TaskBlockedEvent,
  TaskSkippedEvent,
  TaskFailedEvent,
  TaskReplannedEvent,
  TasksInvalidatedEvent,
  ReplanStartedEvent,
  ReplanL2Event,
  ReplanFinishedEvent,
  IntegrationStartedEvent,
  IntegrationFinishedEvent,
  IntegrationFailedEvent,
  BisectStartedEvent,
  BisectCulpritEvent,
  MergeConflictEvent,
  UsageRecordedEvent,
  RateLimitBackoffEvent,
]);

export const EVENT_TYPES = [
  "run.created",
  "run.routed",
  "run.paused",
  "run.resumed",
  "run.reopened",
  "run.finished",
  "run.budget.warning",
  "run.budget.exceeded",
  "plan.started",
  "plan.produced",
  "plan.lint",
  "plan.approved",
  "plan.rejected",
  "plan.format_rejected",
  "plan.ready",
  "contracts.committed",
  "setup.done",
  "batch.started",
  "batch.merged",
  "task.ready",
  "task.worktree.created",
  "task.session.started",
  "task.session.ended",
  "task.scope.checked",
  "scope.checked",
  "task.verify.started",
  "task.verify.finished",
  "task.healing",
  "task.passed",
  "task.merged",
  "task.blocked",
  "task.skipped",
  "task.failed",
  "task.replanned",
  "tasks.invalidated",
  "replan.started",
  "replan.finished",
  "replan.l2",
  "integration.started",
  "integration.finished",
  "integration.failed",
  "bisect.started",
  "bisect.culprit",
  "merge.conflict",
  "usage.recorded",
  "rate_limit.backoff",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EngineEventV1 = z.infer<typeof EngineEventV1>;

export type EventData<T extends EventType> = Extract<
  EngineEventV1,
  { type: T }
>["data"];

export function parseEngineEvent(value: unknown): EngineEventV1 {
  const result = EngineEventV1.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const typeName =
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).type === "string"
      ? (value as Record<string, unknown>).type
      : "<none>";
  const error = new ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: `invalid event type ${typeName}: ${result.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    },
  ]);
  throw error;
}
