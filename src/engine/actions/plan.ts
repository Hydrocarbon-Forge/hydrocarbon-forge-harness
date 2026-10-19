import type { EventData, EventType } from "../../contracts/events.js";
import { PlannerFailure, runPlanner, type PlannerEmit } from "../../roles/planner.js";
import { resolvePlannerRoute } from "../../roles/router.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { adapterFor } from "./shared.js";
import { runLintAction } from "./approve.js";
import { log } from "../../util/log.js";

/**
 * The `plan` action: resolve the planner route, hand the planner the emitter so
 * its usage events are recorded while the session runs, and turn the planner's
 * outcome into events. The `lint` action belongs to approve.ts.
 */
export async function runPlanAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  if (action.type === "lint") {
    await runLintAction(action, ctx, state, emit);
    return;
  }

  emit("plan.started", {});

  const route = resolvePlannerRoute(ctx.settings);
  const adapter = adapterFor(ctx, route.backend);
  if (!adapter) {
    emit("run.paused", { reason: "backend_unavailable" });
    return;
  }

  let totalUsd = state.usage.total_usd;
  let stoppedForBudget = false;

  const plannerEmit: PlannerEmit = <T extends EventType>(
    type: T,
    data: EventData<T>
  ) => {
    const evt = emit(type, data);
    if (type === "usage.recorded") {
      const record = (data as { record?: { cost_usd?: number } })?.record;
      totalUsd += record?.cost_usd ?? 0;
      log.debug(`[DEBUG] plan action: planner usage ${totalUsd.toFixed(2)}`);
      if (checkRunBudget(ctx, emit, totalUsd)) {
        // The run is paused for the budget; do not report a plan outcome for it.
        stoppedForBudget = true;
      }
    }
    return evt;
  };

  let outcome;
  try {
    outcome = await runPlanner({
      runId: ctx.runId,
      repoRoot: ctx.repoRoot,
      runDir: ctx.runDir,
      request: ctx.prompt ?? "",
      settings: ctx.settings,
      adapter,
      route,
      onEvent: plannerEmit,
    });
  } catch (err) {
    if (stoppedForBudget) return;

    if (err instanceof PlannerFailure) {
      const failureClass = err.reason === "session" ? "worker_crashed" : "spec_invalid";
      emit("task.failed", { failure_class: failureClass });
      emit("run.finished", { exit_code: 1, status: "failed" });
      return;
    }
    throw err;
  }

  if (stoppedForBudget) return;

  if (outcome.kind === "needs_input") {
    emit("run.paused", {
      reason: "needs_human",
      questions_path: outcome.questionsPath,
      session_id: outcome.sessionId,
    });
    return;
  }

  emit("contracts.committed", { commit_sha: outcome.commitSha });
  emit("plan.produced", {
    manifest: outcome.plan.manifest,
    tasks: outcome.plan.manifest.tasks,
    commit_sha: outcome.commitSha,
  });
}
