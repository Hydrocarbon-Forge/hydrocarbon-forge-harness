import { z, ZodError } from "zod";

import {
  FailureClass,
  PauseReason,
  UsageRecord,
  RoleName,
} from "./index.js";

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
    })
    .strict()
);

export const RunRoutedEvent = member(
  "run.routed",
  z.object({ mode: z.enum(["solo", "plan"]) }).strict()
);

export const RunPausedEvent = member(
  "run.paused",
  z
    .object({
      reason: PauseReason,
      questions_path: z.string().optional(),
      session_id: z.string().optional(),
    })
    .strict()
);

export const RunResumedEvent = member("run.resumed", z.object({}).strict());

export const RunFinishedEvent = member(
  "run.finished",
  z
    .object({
      exit_code: z.number().int(),
      status: z.string().optional(),
      reason: z.string().optional(),
      files: z.array(z.string()).optional(),
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

export const PlanProducedEvent = member(
  "plan.produced",
  z
    .object({
      manifest: z.unknown().optional(),
      tasks: z.array(z.unknown()).optional(),
      commit_sha: z.string().optional(),
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

export const PlanReadyEvent = member("plan.ready", z.object({}).strict());

export const ContractsCommittedEvent = member(
  "contracts.committed",
  z.object({ commit_sha: z.string().optional() }).strict()
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
  z.object({}).strict()
);

export const IntegrationFinishedEvent = member(
  "integration.finished",
  z.object({ passed: z.boolean() }).strict()
);

export const IntegrationFailedEvent = member(
  "integration.failed",
  z.object({ base: z.boolean().optional() }).strict()
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

export const GovernorFallbackEvent = member(
  "governor.fallback",
  z.object({ reason: z.string() }).strict()
);

export const EngineEventV1 = z.discriminatedUnion("type", [
  RunCreatedEvent,
  RunRoutedEvent,
  RunPausedEvent,
  RunResumedEvent,
  RunFinishedEvent,
  RunBudgetWarningEvent,
  RunBudgetExceededEvent,
  PlanStartedEvent,
  PlanProducedEvent,
  PlanLintEvent,
  PlanApprovedEvent,
  PlanRejectedEvent,
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
  GovernorFallbackEvent,
]);

export const EVENT_TYPES = [
  "run.created",
  "run.routed",
  "run.paused",
  "run.resumed",
  "run.finished",
  "run.budget.warning",
  "run.budget.exceeded",
  "plan.started",
  "plan.produced",
  "plan.lint",
  "plan.approved",
  "plan.rejected",
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
  "governor.fallback",
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
