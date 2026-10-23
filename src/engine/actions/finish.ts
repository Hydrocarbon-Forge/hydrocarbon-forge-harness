import type { EffectContext } from "../effects.js";
import type { EngineState } from "../reducer.js";
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
