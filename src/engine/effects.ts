import type {
  EngineEvent,
  HarnessAdapter,
  PauseReason,
  PermissionMode,
  RunId,
  Settings,
  TaskId,
} from "../contracts/index.js";
import { type EventType, type EventData, parseEngineEvent } from "../contracts/events.js";
import type { AdapterMap } from "../backends/registry.js";
import { type EngineState, reduce, type TaskRuntimeState } from "./reducer.js";
import { log } from "../util/log.js";
import { makeEmitter } from "./emit.js";
import type { Emit } from "./actions/shared.js";
import { blockedPendingTasks, promoteReadyTasks, scheduleNextTasks } from "./scheduler.js";
import type { UsageLedgerEntry } from "../contracts/index.js";
import { appendUsage, ledgerPaths } from "../ledger/usage.js";
import { EventStoreImpl } from "../store/event-store.js";
import { runRouteAction } from "./actions/route.js";
import { runPlanAction } from "./actions/plan.js";
import { runSetupAction } from "./actions/setup.js";
import { runTaskAction } from "./actions/task.js";
import { runReplanAction } from "./actions/replan.js";
import { runMergeAction } from "./actions/merge.js";
import { runIntegrateAction } from "./actions/integrate.js";
import { runApproveAction } from "./actions/approve.js";
import { runFinishAction } from "./actions/finish.js";

export { safeParseManifest, safeLoadPlan } from "./actions/shared.js";

export type EngineActionType =
  | "route"
  | "plan"
  | "lint"
  | "setup"
  | "worker"
  | "heal"
  | "replan"
  | "merge"
  | "integration"
  | "gate"
  | "abort";

export interface EngineAction {
  type: EngineActionType;
  taskId?: TaskId;
  batch?: TaskId[];
  reason?: PauseReason | "budget" | "timeout" | "cancel";
}

export interface EffectContext {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  settings: Settings;
  adapters: AdapterMap;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
  prompt?: string;
  mode?: "auto" | "solo" | "plan";
  permission_mode?: PermissionMode;
  preBatchCheckpoint?: string;
  baseChecked?: boolean;
  store?: EventStoreImpl;
}

function isTerminal(state: EngineState): boolean {
  return (
    state.state === "FINISHED" ||
    state.state === "FAILED" ||
    state.state === "CANCELLED" ||
    state.state === "PAUSED"
  );
}

/**
 * Tasks ordered topologically (dependencies first) then by task id. Cycles are
 * rejected by `setup`, so the depth walk only has to be defensive.
 */
function topologicalOrder(tasks: TaskRuntimeState[]): TaskId[] {
  const byId = new Map<TaskId, TaskRuntimeState>(tasks.map((t) => [t.id, t]));
  const depth = new Map<TaskId, number>();

  function depthOf(id: TaskId, path: Set<TaskId>): number {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (path.has(id)) return 0;
    path.add(id);
    let d = 0;
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (byId.has(dep)) d = Math.max(d, depthOf(dep, path) + 1);
    }
    path.delete(id);
    depth.set(id, d);
    return d;
  }

  return tasks
    .slice()
    .sort(
      (a, b) =>
        depthOf(a.id, new Set<TaskId>()) - depthOf(b.id, new Set<TaskId>()) ||
        a.id.localeCompare(b.id)
    )
    .map((t) => t.id);
}

export function nextActions(
  state: EngineState,
  settings: Settings
): EngineAction[] {
  if (isTerminal(state)) {
    return [];
  }

  const maxUsd = settings.budgets?.run?.max_usd;
  if (maxUsd !== undefined && state.usage.total_usd >= maxUsd) {
    return [{ type: "abort", reason: "budget" }];
  }

  switch (state.state) {
    case "CREATED":
    case "ROUTING":
      return [{ type: "route" }];

    case "PLANNING":
      return [{ type: "plan" }];

    case "LINTING":
      return [{ type: "lint" }];

    case "AWAITING_APPROVAL":
      return [{ type: "gate", reason: "needs_approval" }];

    case "SETUP":
      return [{ type: "setup" }];

    case "INTEGRATING":
      return [{ type: "integration" }];

    case "EXECUTING": {
      const tasks = Object.values(state.tasks);
      if (tasks.length === 0) {
        // Nothing was planned: integration verifies the base checkpoint and is
        // the only action that may report the run as finished.
        return [{ type: "integration" }];
      }

      const healingTasks = tasks.filter((t) => t.state === "HEALING");
      if (healingTasks.length > 0) {
        return healingTasks.map((t) => ({ type: "heal", taskId: t.id }));
      }

      const replanTasks = tasks.filter(
        (t) =>
          t.state === "REPLANNING" ||
          (t.state === "FAILED" &&
            t.failure_class !== "permission_denied" &&
            t.failure_class !== "rate_limited")
      );
      if (replanTasks.length > 0) {
        return replanTasks.map((t) => ({ type: "replan", taskId: t.id }));
      }

      const inFlightTasks = tasks.filter(
        (t) =>
          t.state === "RUNNING" ||
          t.state === "SCOPE_CHECK" ||
          t.state === "VERIFYING"
      );

      // Dependents move as soon as a passed task is merged, without waiting for
      // every task to pass.
      if (inFlightTasks.length === 0) {
        const passedTasks = tasks.filter((t) => t.state === "PASSED" || t.state === "MERGING");
        if (passedTasks.length > 0) {
          return [{ type: "merge", batch: topologicalOrder(passedTasks) }];
        }
      }

      const scheduled = scheduleNextTasks(state, settings, inFlightTasks.length);
      if (scheduled.length > 0) {
        return scheduled.map((taskId) => ({ type: "worker", taskId }));
      }

      if (inFlightTasks.length > 0) {
        return [];
      }

      const mergedTasks = tasks.filter((t) => t.state === "MERGED");
      if (mergedTasks.length === tasks.length) {
        return [{ type: "integration" }];
      }

      return [];
    }

    default:
      return [];
  }
}

export async function executeAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState
): Promise<EngineEvent[]> {
  const { events, emit } = makeEmitter(ctx, state);

  if (action.type === "worker" || action.type === "heal") {
    await runTaskAction(action, ctx, state, emit);
  } else {
    switch (action.type) {
      case "route":
        await runRouteAction(action, ctx, state, emit);
        break;
      case "plan":
      case "lint":
        await runPlanAction(action, ctx, state, emit);
        break;
      case "setup":
        await runSetupAction(action, ctx, state, emit);
        break;
      case "replan":
        await runReplanAction(action, ctx, state, emit);
        break;
      case "merge":
        await runMergeAction(action, ctx, state, emit);
        break;
      case "integration":
        await runIntegrateAction(action, ctx, state, emit);
        break;
      case "gate":
        await runApproveAction(action, ctx, state, emit);
        break;
      case "abort":
        await runFinishAction(action, ctx, state, emit);
        break;
      default:
        break;
    }
  }

  return events;
}

function storeFor(ctx: EffectContext): EventStoreImpl {
  return ctx.store ?? new EventStoreImpl(ctx.runId, { runDir: ctx.runDir });
}

export function appendRunEvent(ctx: EffectContext, event: EngineEvent): void {
  // The catalog is checked first so nothing is appended for an event that is not
  // in the catalog or whose data does not match its member shape. The store then
  // validates the envelope and the sequence numbering. One store instance per run
  // keeps the sequence cached, so a torn last line is skipped rather than read as
  // a middle-line corruption.
  parseEngineEvent(event);
  storeFor(ctx).appendSync(event);
}

// Budget check per R1.4: after each usage.recorded the action compares the
// running total with settings.budgets.run.max_usd. Emits the warning while
// below the cap; emits exceeded+paused at or above it. Returns true when the
// run must stop for budget.
export function checkRunBudget(
  ctx: EffectContext,
  emit: Emit,
  currentTotal: number
): boolean {
  const maxUsd = ctx.settings.budgets?.run?.max_usd;
  if (maxUsd === undefined) return false;
  if (currentTotal >= 0.8 * maxUsd && currentTotal < maxUsd) {
    emit("run.budget.warning", { cost_usd: currentTotal, max_usd: maxUsd });
  }
  if (currentTotal >= maxUsd) {
    emit("run.budget.exceeded", { cost_usd: currentTotal, max_usd: maxUsd });
    emit("run.paused", { reason: "budget_exhausted" });
    return true;
  }
  return false;
}

// Builds a ledger entry from a usage.recorded event (Behavior 11 of the
// event catalog) and appends exactly one line to the project ledger and, when
// enabled, to the global mirror.
function appendUsageForEvent(ctx: EffectContext, evt: EngineEvent): void {
  const data = (evt.data ?? {}) as Record<string, any>;
  const record = data.record ?? {};
  const entry: UsageLedgerEntry = {
    v: 1,
    ts: evt.ts,
    project: ctx.repoRoot,
    run_id: evt.run_id,
    task_id: data.task_id,
    generation: data.generation,
    attempt: data.attempt,
    role: data.role ?? "worker",
    class: data.class,
    backend: record.backend,
    model: record.model,
    effort: undefined,
    input_tokens: record.input_tokens ?? 0,
    output_tokens: record.output_tokens ?? 0,
    cache_read_tokens: record.cache_read_tokens,
    cache_write_tokens: record.cache_write_tokens,
    reasoning_tokens: record.reasoning_tokens,
    cost_usd: record.cost_usd ?? 0,
    cost_source: record.cost_source ?? "unknown",
  };
  const paths = ledgerPaths({
    projectRoot: ctx.repoRoot,
    globalEnabled: ctx.settings.usage?.global ?? true,
    env: process.env,
  });
  try {
    appendUsage(entry, paths);
  } catch (err: any) {
    log.warn(`failed to append usage to project ledger: ${err?.message ?? String(err)}`);
  }
}

export async function runEffectsLoop(
  ctx: EffectContext,
  initialState: EngineState
): Promise<EngineState> {
  const store = storeFor(ctx);
  const existingEvents = store.readAllSync();
  let seq = existingEvents.length > 0 ? existingEvents[existingEvents.length - 1].seq : 0;
  let persistedSeqs: Set<number> | undefined = undefined;

  let state = initialState;

  // The loop emits the events it derives itself (promotions, blocks, the stall
  // result), so every state change is still an appended event.
  const emitLoopEvent = <T extends EventType>(type: T, data: EventData<T>): EngineEvent => {
    const emitter = makeEmitter(ctx, { ...(state as any), _seq: seq } as EngineState);
    const evt = emitter.emit(type, data);
    seq = evt.seq;
    return evt;
  };

  const applyEvent = (evt: EngineEvent): EngineState => {
    state = reduce(state, evt);
    if (evt.type === "run.finished") {
      state = {
        ...state,
        state: (evt.data as any)?.exit_code === 0 ? "FINISHED" : "FAILED",
      };
    }
    (state as any)._seq = seq;
    return state;
  };

  const settleDependents = (): void => {
    for (const taskId of blockedPendingTasks(state)) {
      applyEvent(emitLoopEvent("task.blocked", { task_id: taskId }));
    }
    for (const taskId of promoteReadyTasks(state)) {
      applyEvent(emitLoopEvent("task.ready", { task_id: taskId }));
    }
  };

  while (!isTerminal(state)) {
    if (ctx.signal?.aborted) {
      applyEvent(emitLoopEvent("run.paused", { reason: "user_cancel" }));
      break;
    }

    const actions = nextActions(state, ctx.settings);
    if (actions.length === 0) {
      log.debug("[DEBUG] runEffectsLoop: no actions while state is", state.state);
      applyEvent(
        emitLoopEvent("run.finished", { exit_code: 1, status: "failed", reason: "stalled" })
      );
      break;
    }

    for (const action of actions) {
      (state as any)._seq = seq;
      const crashedBefore = Boolean((ctx as any)._observabilityCrashed);
      const actionEvents = await executeAction(action, ctx, state);

      // Usage ledger: one line per persisted usage.recorded event. Events
      // emitted after an observer crash are not in the log, so they must not
      // reach the ledger either.
      if ((ctx as any)._observabilityCrashed && !crashedBefore) {
        persistedSeqs = new Set(store.readAllSync().map((e) => e.seq));
      }
      for (const evt of actionEvents) {
        if (evt.type === "usage.recorded") {
          if (persistedSeqs && !persistedSeqs.has(evt.seq)) continue;
          appendUsageForEvent(ctx, evt);
        }
      }

      for (const evt of actionEvents) {
        if (typeof evt.seq === "number") {
          seq = evt.seq;
        }
        log.debug("[DEBUG] evt:", evt.type, evt.data);
        applyEvent(evt);
        settleDependents();
      }

      if (isTerminal(state)) {
        break;
      }
    }
  }

  log.debug("[DEBUG] runEffectsLoop loop finished, final state:", state.state);
  return state;
}
