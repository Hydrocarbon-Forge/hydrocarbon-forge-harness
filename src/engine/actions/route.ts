import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { workspaceManager } from "../../git/index.js";
import { routeRequest } from "../../roles/router.js";

export async function runRouteAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  // Auto mode runs the deterministic router: explicit flags, then the mechanical-file
  // rule, then the plan default. An explicit solo or plan mode bypasses the router.
  let mode: "solo" | "plan" = ctx.mode === "solo" ? "solo" : "plan";
  if (ctx.mode === "auto") {
    const decision = await routeRequest({
      prompt: ctx.prompt ?? "",
      flags: { mode: ctx.mode },
      settings: ctx.settings,
      repoRoot: ctx.repoRoot,
    });
    mode = decision.mode;
  }

  if (mode === "solo") {
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

  emit("run.routed", { mode: "plan" });
}
