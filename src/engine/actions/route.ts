import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { workspaceManager } from "../../git/index.js";

export async function runRouteAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  if (ctx.mode === "solo") {
    await workspaceManager.createRunBranch(ctx.repoRoot, ctx.runId, "HEAD");
    emit("run.routed", { mode: "solo" });
    emit("setup.done", {
      tasks: [
        {
          id: "SOLO",
          depends_on: [],
          write: ["**"],
          create: ["**"],
        },
      ],
    });
    emit("task.ready", { task_id: "SOLO" });
    return;
  }

  // Plan mode, and auto mode (which takes the plan route until the deterministic
  // routeRequest is wired into this action).
  emit("run.routed", { mode: "plan" });
}
