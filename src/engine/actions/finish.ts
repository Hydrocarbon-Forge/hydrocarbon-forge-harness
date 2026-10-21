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
    // R11.1: the spend and the cap in effect, so the stop names them (landRun reads them).
    emit("run.budget.exceeded", { cost_usd: state.usage.total_usd, max_usd: ctx.settings.budgets.run.max_usd });
    emit("run.paused", { reason: "budget_exhausted" });
  } else if (action.reason) {
    emit("run.paused", { reason: action.reason });
  } else {
    return finishAction(ctx, state);
  }
}
