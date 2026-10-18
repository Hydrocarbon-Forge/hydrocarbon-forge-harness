import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";

export function runFinishAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): void {
  if (action.reason === "budget") {
    emit("run.budget.exceeded", {});
    emit("run.paused", { reason: "budget_exhausted" });
  } else {
    emit("run.paused", { reason: action.reason ?? "user_cancel" });
  }
}
