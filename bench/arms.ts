import type { Settings, TaskClass } from "../src/contracts/index.js";
import type { ArmConfig, BenchmarkArm, BenchmarkRunConfig } from "./types.js";

export function resolveArmConfig(
  arm: BenchmarkArm,
  settings: Settings,
  config: BenchmarkRunConfig
): ArmConfig {
  switch (arm) {
    case "A": {
      const model = config.topModel ?? settings.roles?.planner?.model;
      if (!model || model.trim() === "") {
        throw new Error("Arm A requires an explicit model (planner model missing or empty)");
      }
      return {
        arm: "A",
        mode: "solo",
        effort: "high",
        model,
        backend: settings.roles?.planner?.backend ?? "claude",
      };
    }
    case "B": {
      const mechRoute = settings.routing?.mechanical as any;
      const model =
        config.cheapModel ??
        (mechRoute && typeof mechRoute === "object" ? mechRoute.model : undefined);
      if (!model || model.trim() === "") {
        throw new Error(
          "Arm B requires an explicit mechanical route model (missing or empty)"
        );
      }
      return {
        arm: "B",
        mode: "solo",
        effort: "low",
        model,
        backend: (mechRoute && mechRoute.backend) ?? "claude",
      };
    }
    case "C": {
      const model = settings.roles?.planner?.model;
      if (!model || model.trim() === "") {
        throw new Error("Arm C requires a planner model to be declared in settings");
      }
      return {
        arm: "C",
        mode: "plan",
        model,
        backend: settings.roles?.planner?.backend ?? "claude",
      };
    }
    case "D": {
      const model = settings.roles?.planner?.model;
      if (!model || model.trim() === "") {
        throw new Error("Arm D requires a planner model to be declared in settings");
      }
      const localModel = config.localModel ?? "qwen2.5-coder-7b-instruct";
      const routeOverrides: Record<
        TaskClass,
        { backend: any; model: string; effort?: any }
      > = {
        mechanical: {
          backend: "opencode",
          model: localModel,
          effort: "low",
        },
        boilerplate: {
          backend: "opencode",
          model: localModel,
          effort: "low",
        },
      } as any;
      return {
        arm: "D",
        mode: "plan",
        model,
        backend: settings.roles?.planner?.backend ?? "claude",
        routeOverrides,
      };
    }
    default:
      throw new Error(`Unknown or invalid benchmark arm identifier: ${arm}`);
  }
}
