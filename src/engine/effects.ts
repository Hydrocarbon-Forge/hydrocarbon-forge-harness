import fs from "node:fs";
import path from "node:path";

import type {
  EngineEvent,
  HarnessAdapter,
  PauseReason,
  PermissionMode,
  RunId,
  Settings,
  TaskId,
} from "../contracts/index.js";
import { type EngineState, reduce } from "./reducer.js";
import { log } from "../util/log.js";
import { makeEmitter } from "./actions/shared.js";
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
  adapter: HarnessAdapter;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
  prompt?: string;
  mode?: "auto" | "solo" | "plan";
  permission_mode?: PermissionMode;
  preBatchCheckpoint?: string;
  baseChecked?: boolean;
}

export function nextActions(
  state: EngineState,
  settings: Settings
): EngineAction[] {
  if (
    state.state === "PAUSED" ||
    state.state === "FINISHED" ||
    state.state === "FAILED" ||
    state.state === "CANCELLED"
  ) {
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
        return [];
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

      const readyTasks = tasks
        .filter((t) => t.state === "READY")
        .sort((a, b) => a.id.localeCompare(b.id));

      if (readyTasks.length > 0) {
        const concurrency = settings.concurrency?.workers ?? 4;
        const activeRunning = tasks.filter(
          (t) =>
            t.state === "RUNNING" ||
            t.state === "SCOPE_CHECK" ||
            t.state === "VERIFYING"
        ).length;
        const slots = Math.max(0, concurrency - activeRunning);
        return readyTasks.slice(0, slots).map((t) => ({
          type: "worker",
          taskId: t.id,
        }));
      }

      const inFlightTasks = tasks.filter(
        (t) =>
          t.state === "RUNNING" ||
          t.state === "SCOPE_CHECK" ||
          t.state === "VERIFYING"
      );
      if (inFlightTasks.length > 0) {
        return [];
      }

      const passedTasks = tasks
        .filter((t) => t.state === "PASSED" || t.state === "MERGING")
        .sort((a, b) => a.id.localeCompare(b.id));

      if (passedTasks.length > 0) {
        const unmergedNonPassed = tasks.filter(
          (t) => t.state !== "PASSED" && t.state !== "MERGING" && t.state !== "MERGED"
        );
        if (unmergedNonPassed.length === 0) {
          return [
            {
              type: "merge",
              batch: passedTasks.map((t) => t.id),
            },
          ];
        }
      }

      const mergedTasks = tasks.filter((t) => t.state === "MERGED");
      if (mergedTasks.length > 0 && mergedTasks.length === tasks.length) {
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

export function appendRunEvent(runDir: string, event: EngineEvent): void {
  const eventsPath = path.join(runDir, "events.jsonl");
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
}

export function readAllRunEvents(runDir: string): EngineEvent[] {
  const eventsPath = path.join(runDir, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: EngineEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

export async function runEffectsLoop(
  ctx: EffectContext,
  initialState: EngineState
): Promise<EngineState> {
  const existingEvents = readAllRunEvents(ctx.runDir);
  let seq = existingEvents.length > 0 ? existingEvents[existingEvents.length - 1].seq : 0;

  let state = initialState;
  (state as any)._seq = seq;

  while (
    state.state !== "FINISHED" &&
    state.state !== "PAUSED" &&
    state.state !== "FAILED" &&
    state.state !== "CANCELLED"
  ) {
    if (ctx.signal?.aborted) {
      seq++;
      const cancelEvt: EngineEvent = {
        v: 1,
        seq,
        ts: new Date().toISOString(),
        run_id: ctx.runId,
        type: "run.paused",
        data: { reason: "user_cancel" },
      };
      appendRunEvent(ctx.runDir, cancelEvt);
      ctx.onEvent?.(cancelEvt);
      state = reduce(state, cancelEvt);
      break;
    }

    const actions = nextActions(state, ctx.settings);
    if (actions.length === 0) {
      break;
    }

    for (const action of actions) {
      (state as any)._seq = seq;
      const actionEvents = await executeAction(action, ctx, state);

      for (const evt of actionEvents) {
        seq++;
        evt.seq = seq;
        appendRunEvent(ctx.runDir, evt);
        ctx.onEvent?.(evt);
        log.debug("[DEBUG] evt:", evt.type, evt.data);
        state = reduce(state, evt);
        if (evt.type === "run.finished") {
          state = {
            ...state,
            state: (evt.data as any)?.exit_code === 0 ? "FINISHED" : "FAILED",
          };
        }
        (state as any)._seq = seq;
      }

      if (
        state.state === "FINISHED" ||
        state.state === "PAUSED" ||
        state.state === "FAILED" ||
        state.state === "CANCELLED"
      ) {
        break;
      }
    }
  }

  log.debug("[DEBUG] runEffectsLoop loop finished, final state:", state.state);
  return state;
}
