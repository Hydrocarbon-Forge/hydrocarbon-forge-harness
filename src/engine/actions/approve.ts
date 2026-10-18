import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";

export function runApproveAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): void {
  emit("run.paused", { reason: action.reason ?? "needs_approval" });
}
