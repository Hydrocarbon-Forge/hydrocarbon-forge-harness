import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { archiveRun } from "../../archive/index.js";

export async function finishAction(
  ctx: EffectContext,
  state: EngineState
): Promise<void> {
  if (state.state === "FINISHED" || state.state === "FAILED" || state.state === "CANCELLED") {
    await archiveRun({
      repoRoot: ctx.repoRoot,
      runId: ctx.runId,
      runDir: ctx.runDir,
    });
  }
}

export function runFinishAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): void | Promise<void> {
  if (action.reason === "budget") {
    emit("run.budget.exceeded", {});
    emit("run.paused", { reason: "budget_exhausted" });
  } else if (action.reason) {
    emit("run.paused", { reason: action.reason });
  } else {
    return finishAction(ctx, state);
  }
}
