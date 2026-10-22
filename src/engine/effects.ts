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
import { type EngineState, type TaskRuntimeState } from "./reducer.js";
import { log } from "../util/log.js";
import { makeEmitter } from "./emit.js";
import type { Emit } from "./actions/shared.js";
import {
  blockedPendingTasks,
  promoteReadyTasks,
  scheduleNextTasks,
  unreleasedRootTasks,
} from "./scheduler.js";
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
import { runFinishAction, finishAction } from "./actions/finish.js";
import { getTaskBranch, sweepRunWorkspaces } from "../git/index.js";
import { withRepoLock } from "../git/repo-lock.js";
import { applyJournalEvent, usageTokensOf, type RunJournal } from "./journal.js";
import { timeLimitSecondsOf } from "./time-limit.js";
import { drainInbox } from "./amendment.js";

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

/**
 * The signal the run's planner and single-worker sessions stop on (R11.2): the user's interrupt, the run's
 * time limit, or a stop of the run's workers. Undefined when the context has none of them.
 */
export function interruptOf(ctx: EffectContext): AbortSignal | undefined {
  const signals = [ctx.signal, ctx.timeout, ctx.runStop?.signal].filter((s): s is AbortSignal => s !== undefined);
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

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
  /**
   * Effective worker concurrency for this run (R3.4), initialised from
   * `settings.concurrency.workers` and halved on a rate limit with floor 1. The
   * settings value itself is never mutated.
   */
  concurrency: number;
  /** Which run budget warnings have fired, so the 80 percent warning is emitted once. */
  budgetWarned?: { cost: boolean; tokens: boolean };
  signal?: AbortSignal;
  /** Aborts when the run's wall-clock limit is reached (R11.2); the run then pauses with reason timeout. */
  timeout?: AbortSignal;
  /**
   * Stops every in-flight worker of the run at once (R8.3): a run budget stop, a run pause or
   * a finished run aborts it. Workers listen to it together with `signal`.
   */
  runStop?: AbortController;
  onEvent?: (event: EngineEvent) => void;
  prompt?: string;
  mode?: "auto" | "solo" | "plan";
  permission_mode?: PermissionMode;
  preBatchCheckpoint?: string;
  store?: EventStoreImpl;
  /** The live journal of the run (R8.3), set by runEffectsLoop. */
  journal?: RunJournal;
  /** True when this loop runs in a resume: an amendment applied now is recorded as applied on resume (W5a). */
  resumed?: boolean;
}

/** How long the loop waits for a worker before it looks at the inbox again (W5a). */
const INBOX_WAKE_MS = 1000;

function isTerminal(state: EngineState): boolean {
  return (
    state.state === "FINISHED" ||
    state.state === "PLANNED" ||
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

/** What the effects loop knows about the work already in flight (R8.3). */
export interface NextActionLimits {
  /** Effective worker concurrency for this run. */
  concurrency: number;
  /** Tasks whose worker (or heal) action the loop has already started and not yet finished. */
  running?: TaskId[];
}

export function nextActions(
  state: EngineState,
  settings: Settings,
  limits?: NextActionLimits
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

      const running = limits?.running ?? [];
      const healingTasks = tasks.filter((t) => t.state === "HEALING");

      const replanTasks = tasks.filter(
        (t) =>
          t.id !== "SOLO" &&
          (t.state === "REPLANNING" ||
            (t.state === "FAILED" &&
              t.failure_class !== "permission_denied" &&
              t.failure_class !== "rate_limited"))
      );
      // A pending replan changes the plan, so it runs alone: the loop starts nothing else
      // until the in-flight actions have settled. Heals go first, as before.
      if (healingTasks.length === 0 && replanTasks.length > 0) {
        return replanTasks.map((t) => ({ type: "replan", taskId: t.id }));
      }

      const inFlightTasks = tasks.filter(
        (t) =>
          t.state === "RUNNING" ||
          t.state === "SCOPE_CHECK" ||
          t.state === "VERIFYING"
      );
      const busy = inFlightTasks.length > 0 || running.length > 0;
      const passedTasks = tasks.filter((t) => t.state === "PASSED" || t.state === "MERGING");

      // The effective limit comes from the run copy, never from a mutated settings
      // object. The copy keeps every other field so the scheduler's own budget rules
      // still see them. Tasks the loop already runs are not offered again, and they take
      // their slots from the limit.
      const effectiveConcurrency = limits?.concurrency ?? settings.concurrency.workers;
      const scheduled = scheduleNextTasks(
        state,
        { ...settings, concurrency: { workers: effectiveConcurrency } },
        Math.max(inFlightTasks.length, running.length),
        running
      ).map((taskId) => ({ type: "worker", taskId }) as EngineAction);

      const healActions = healingTasks.map((t) => ({ type: "heal", taskId: t.id }) as EngineAction);

      // Dependents move as soon as a passed task is merged. A merge may run while workers are
      // still in flight (R8.3): the loop runs at most one merge at a time.
      if (passedTasks.length > 0) {
        const merge: EngineAction = { type: "merge", batch: topologicalOrder(passedTasks) };
        if (!busy && healActions.length === 0) {
          return [merge];
        }
        return [...healActions, merge, ...scheduled];
      }

      if (healActions.length > 0 || scheduled.length > 0) {
        return [...healActions, ...scheduled];
      }

      if (busy) {
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

/**
 * Commits one event to the run (R8.3): it is appended to the log (unless the observer has crashed,
 * then it is not persisted), its usage is written to the ledger, and it is reduced into the live
 * journal. The whole step is synchronous, so events from concurrent workers are committed one at a
 * time, in emission order, and the reduced state is always the replay of the log.
 */
export function commitEvent(
  ctx: EffectContext,
  journal: RunJournal,
  evt: EngineEvent,
  persist: boolean
): void {
  if (persist) {
    appendRunEvent(ctx, evt);
    if (evt.type === "usage.recorded") {
      appendUsageForEvent(ctx, evt);
    }
  }
  journal.seq = evt.seq;
  journal.tokens += usageTokensOf(evt);
  journal.state = applyJournalEvent(journal.state, evt);
}

// Budget check per R1.4 and R3.4: after each usage.recorded the action compares the
// running total with settings.budgets.run.max_usd and budgets.run.max_tokens. The
// 80 percent warning is emitted once per run; at 100 percent the run pauses and the
// session is killed by the caller. The total the caller passes is state.usage plus the
// pending usage this action has recorded, so an event is never counted twice.
export function checkRunBudget(
  ctx: EffectContext,
  emit: Emit,
  currentTotal: number,
  currentTokens?: number
): boolean {
  // R8.3: a run that is already paused (another worker's budget stop) is stopped silently.
  if (ctx.journal?.state.state === "PAUSED") {
    return true;
  }

  const warned = (ctx.budgetWarned ??= { cost: false, tokens: false });

  const maxUsd = ctx.settings.budgets?.run?.max_usd;
  if (maxUsd !== undefined) {
    if (currentTotal >= 0.8 * maxUsd && currentTotal < maxUsd && !warned.cost) {
      warned.cost = true;
      emit("run.budget.warning", {
        cost_usd: currentTotal,
        max_usd: maxUsd,
        ...(currentTokens !== undefined && ctx.settings.budgets?.run?.max_tokens !== undefined
          ? { tokens: currentTokens, max_tokens: ctx.settings.budgets.run.max_tokens }
          : {}),
      });
    }
    if (currentTotal >= maxUsd) {
      emit("run.budget.exceeded", { cost_usd: currentTotal, max_usd: maxUsd });
      emit("run.paused", { reason: "budget_exhausted" });
      return true;
    }
  }

  const maxTokens = ctx.settings.budgets?.run?.max_tokens;
  if (maxTokens !== undefined && currentTokens !== undefined) {
    if (currentTokens >= 0.8 * maxTokens && currentTokens < maxTokens && !warned.tokens) {
      warned.tokens = true;
      emit("run.budget.warning", { tokens: currentTokens, max_tokens: maxTokens });
    }
    if (currentTokens >= maxTokens) {
      emit("run.budget.exceeded", { tokens: currentTokens, max_tokens: maxTokens });
      emit("run.paused", { reason: "budget_exhausted" });
      return true;
    }
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

/** The kind of an action for scheduling (R8.3): workers run side by side, merges one at a time, the rest alone. */
function kindOf(action: EngineAction): "worker" | "merge" | "exclusive" {
  if (action.type === "worker" || action.type === "heal") return "worker";
  if (action.type === "merge") return "merge";
  return "exclusive";
}

function keyOf(action: EngineAction): string {
  if (kindOf(action) === "worker") return `task:${action.taskId ?? "SOLO"}`;
  if (action.type === "merge") return "merge";
  return `${action.type}:${action.taskId ?? ""}`;
}

interface Flight {
  kind: "worker" | "merge" | "exclusive";
  taskId?: TaskId;
  promise: Promise<void>;
}

/**
 * Runs a run's actions until it reaches a terminal state (R8.3). Up to `concurrency.workers`
 * worker actions run at once, each in its own worktree; a merge runs one at a time and may overlap
 * the workers; any other action runs alone once nothing else is in flight. When an action finishes
 * its events are already committed, dependents are settled, and the scheduler is asked again at
 * once. A terminal state (budget, rate limit pause, interrupt) stops every in-flight worker through
 * `runStop`, and the loop returns only when all of them have settled.
 */
export async function runEffectsLoop(
  ctx: EffectContext,
  initialState: EngineState
): Promise<EngineState> {
  const store = storeFor(ctx);
  const existingEvents = store.readAllSync();
  const journal: RunJournal = {
    state: initialState,
    seq: existingEvents.length > 0 ? existingEvents[existingEvents.length - 1].seq : 0,
    tokens: existingEvents.reduce((total, evt) => total + usageTokensOf(evt), 0),
  };
  ctx.journal = journal;
  const runStop = new AbortController();
  ctx.runStop = runStop;

  // R11.2 (known issue 60): the run's wall-clock limit ends the run as a budget stop does. The run pauses with
  // reason timeout (unless it already ended), and every in-flight worker, planner and single-worker session
  // is stopped; nothing new starts, so nothing merges after the stop.
  const onTimeLimit = (): void => {
    if (!isTerminal(journal.state)) {
      emitLoopEvent("run.paused", { reason: "timeout", time_limit_s: timeLimitSecondsOf(ctx.settings) });
    }
    if (!runStop.signal.aborted) runStop.abort();
  };
  ctx.timeout?.addEventListener("abort", onTimeLimit, { once: true });

  // The loop emits the events it derives itself (promotions, blocks, the stall
  // result). Each one is committed to the journal as it is emitted.
  const emitLoopEvent = <T extends EventType>(type: T, data: EventData<T>): EngineEvent =>
    makeEmitter(ctx, journal.state).emit(type, data);

  const settleDependents = (): void => {
    for (const taskId of blockedPendingTasks(journal.state)) {
      // The dependent never runs: it is skipped, and the event says which upstream
      // task failed (or was itself skipped) so the log and the summary can say why.
      const deps = journal.state.tasks[taskId]?.depends_on ?? [];
      const failed = deps.filter((d) => journal.state.tasks[d]?.state === "BLOCKED");
      const skipped = deps.filter((d) => journal.state.tasks[d]?.state === "ABANDONED");
      makeEmitter(ctx, journal.state).emit("task.skipped", { task_id: taskId, reason: "dependency_failed", failed, skipped });
    }
    for (const taskId of promoteReadyTasks(journal.state)) {
      emitLoopEvent("task.ready", { task_id: taskId });
    }
  };

  // Resume (R5.3 S11): the replayed log may stop after `setup.done`, which leaves the
  // first batch PENDING, or after a `task.merged` / `batch.merged`, which leaves
  // dependents PENDING. Setup and settleDependents would have emitted these
  // promotions, so they are emitted here, before the first action is chosen and
  // therefore before the stall check. Only the resume entry (engine.ts) starts the
  // loop in EXECUTING; a fresh run enters in CREATED and setup releases the first batch.
  if (journal.state.state === "EXECUTING") {
    for (const taskId of unreleasedRootTasks(journal.state)) {
      emitLoopEvent("task.ready", { task_id: taskId });
    }
    settleDependents();
  }

  const flights = new Map<string, Flight>();
  let halted = false;
  let fatal: { error: unknown } | undefined;

  /**
   * W5a (docs/design/web-ui.md, 7.6): applies the inbox's amendments between actions. A merge or an exclusive
   * action in flight holds them back (they move the run branch). When one lands, the tasks it made ready are
   * released and the dependents of a dropped task are skipped, as they are after any settle.
   */
  const drainAmendments = async (): Promise<void> => {
    if (halted) return;
    const applied = await drainInbox({
      runId: ctx.runId,
      repoRoot: ctx.repoRoot,
      runDir: ctx.runDir,
      settings: ctx.settings,
      appliedAt: ctx.resumed ? "resume" : "live",
      getState: () => journal.state,
      mayChange: () => ![...flights.values()].some((f) => f.kind !== "worker"),
      emit: emitLoopEvent,
    });
    if (applied) {
      for (const taskId of unreleasedRootTasks(journal.state)) {
        emitLoopEvent("task.ready", { task_id: taskId });
      }
      settleDependents();
    }
  };

  /** Stops every in-flight worker; the loop then waits for them to settle. */
  const stopWorkers = (): void => {
    if (!runStop.signal.aborted) runStop.abort();
  };

  const halt = (): void => {
    halted = true;
    stopWorkers();
  };

  const start = (action: EngineAction): void => {
    const key = keyOf(action);
    const promise = executeAction(action, ctx, journal.state).then(
      () => {
        flights.delete(key);
      },
      (error: unknown) => {
        flights.delete(key);
        if (!fatal) fatal = { error };
        halt();
      }
    );
    flights.set(key, { kind: kindOf(action), taskId: action.taskId, promise });
  };

  const runningTasks = (): TaskId[] =>
    [...flights.values()]
      .filter((f) => f.kind === "worker" && f.taskId !== undefined)
      .map((f) => f.taskId as TaskId);

  /** Decides what starts now, or ends the run when nothing can run (the loop's one decision point). */
  const plan = (): void => {
    if (ctx.signal?.aborted) {
      if (!isTerminal(journal.state)) {
        emitLoopEvent("run.paused", { reason: "user_cancel" });
      }
      halt();
      return;
    }
    if (isTerminal(journal.state)) {
      halt();
      return;
    }

    const actions = nextActions(journal.state, ctx.settings, {
      concurrency: ctx.concurrency,
      running: runningTasks(),
    });

    if (actions.length === 0) {
      if (flights.size > 0) return;
      log.debug("[DEBUG] runEffectsLoop: no actions while state is", journal.state.state);
      // Nothing can run: a task that failed for good (or was skipped) is the reason, not a
      // stall. The reason names the failed tasks so a caller reads it in the summary.
      const failedIds = Object.values(journal.state.tasks)
        .filter((t) => t.state === "BLOCKED")
        .map((t) => t.id)
        .sort((a, b) => a.localeCompare(b));
      const reason = failedIds.length > 0 ? "tasks_failed" : "stalled";
      emitLoopEvent("run.finished", {
        exit_code: 1,
        status: "failed",
        reason,
        ...(failedIds.length > 0 ? { failed_tasks: failedIds } : {}),
      });
      halt();
      return;
    }

    // A budget stop: the in-flight workers stop now, and the abort action runs once they
    // have settled (it is exclusive).
    if (actions.some((a) => a.type === "abort")) {
      stopWorkers();
    }

    if ([...flights.values()].some((f) => f.kind === "exclusive")) return;

    const exclusive = actions.filter((a) => kindOf(a) === "exclusive");
    if (exclusive.length > 0) {
      if (flights.size === 0) start(exclusive[0]);
      return;
    }

    for (const action of actions) {
      if (flights.has(keyOf(action))) continue;
      if (kindOf(action) === "merge" && [...flights.values()].some((f) => f.kind === "merge")) continue;
      if (runStop.signal.aborted) continue;
      start(action);
    }
  };

  try {
    for (;;) {
      if (!halted) {
        await drainAmendments();
        plan();
      }
      if (flights.size === 0) break;
      // A worker can run for minutes: the loop wakes at least every INBOX_WAKE_MS to look at the inbox.
      let wake: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<void>((resolve) => {
        wake = setTimeout(resolve, INBOX_WAKE_MS);
      });
      await Promise.race([...[...flights.values()].map((f) => f.promise), tick]);
      clearTimeout(wake);
      settleDependents();
    }
  } catch (error: unknown) {
    // An exception in the loop itself (not in an action) stops the workers the same way. The
    // engine records the run as failed (R9.1, internal_error); this loop only makes sure nothing
    // is still running when that happens.
    if (!fatal) fatal = { error };
    halt();
    await Promise.allSettled([...flights.values()].map((f) => f.promise));
  }

  ctx.timeout?.removeEventListener("abort", onTimeLimit);
  if (fatal) {
    throw fatal.error;
  }

  const state = journal.state;
  if (state.state === "FINISHED" || state.state === "FAILED") {
    // A finished or failed run leaves no worktree or task branch behind. The work of
    // every task that did not merge is saved under packets/ first, so it stays evidence.
    const unmerged = new Map<string, string | undefined>();
    for (const task of Object.values(state.tasks)) {
      if (task.state === "MERGED") continue;
      const generation = task.generation ?? 1;
      unmerged.set(`${task.id}-g${generation}`, getTaskBranch(ctx.runId, task.id, generation));
    }
    try {
      await withRepoLock(ctx.repoRoot, () => sweepRunWorkspaces(ctx.repoRoot, ctx.runId, ctx.runDir, unmerged));
    } catch (err: any) {
      log.warn(`failed to remove the run's worktrees and task branches: ${err?.message ?? String(err)}`);
    }
  }
  if (state.state === "FINISHED" || state.state === "FAILED" || state.state === "CANCELLED") {
    await finishAction(ctx, state);
  }

  log.debug("[DEBUG] runEffectsLoop loop finished, final state:", state.state);
  return state;
}
