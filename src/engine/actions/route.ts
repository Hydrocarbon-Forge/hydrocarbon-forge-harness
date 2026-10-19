import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { checkGovernorHealth, callGovernorIntake } from "../../roles/governor.js";
import { routeRequest } from "../../roles/router.js";
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

  if (ctx.mode === "auto") {
    let routedMode: "solo" | "plan" = "plan";
    let governorFailed = false;

    if (
      ctx.settings.roles?.governor?.enabled &&
      ctx.settings.roles?.governor?.endpoint
    ) {
      try {
        const timeoutMs = (ctx.settings.roles.governor.timeout_s ?? 5) * 1000;
        const isHealthy = await checkGovernorHealth(
          ctx.settings.roles.governor.endpoint,
          timeoutMs
        );
        if (isHealthy) {
          const intake = await callGovernorIntake(ctx.prompt ?? "", {
            endpoint: ctx.settings.roles.governor.endpoint,
            model: ctx.settings.roles.governor.model,
            timeoutMs,
            enableThinking: false,
          });
          if (intake.decision?.mode === "solo") {
            routedMode = "solo";
          }
        } else {
          governorFailed = true;
        }
      } catch {
        governorFailed = true;
      }
    }

    if (governorFailed) {
      emit("governor.fallback", { reason: "Governor unavailable" });
      const decision = await routeRequest({
        prompt: ctx.prompt ?? "",
        settings: ctx.settings,
        repoRoot: ctx.repoRoot,
      });
      routedMode = decision.mode;
    }

    emit("run.routed", { mode: routedMode });
    if (routedMode === "solo") {
      await workspaceManager.createRunBranch(ctx.repoRoot, ctx.runId, "HEAD");
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
    }
    return;
  }

  emit("run.routed", { mode: "plan" });
}
