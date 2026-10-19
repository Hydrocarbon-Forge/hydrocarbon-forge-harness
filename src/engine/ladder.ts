import type {
  FailureClass,
  PauseReason,
  Route,
  SessionId,
  Settings,
  TaskClass,
  TaskId,
} from "../contracts/index.js";
import type { EngineState } from "./reducer.js";
import { resolveTaskRoute } from "../roles/router.js";

export type EscalationAction =
  | { level: "L0"; action: "heal"; session_id: SessionId }
  | { level: "L1"; action: "replan"; route: Route; generation: number }
  | { level: "L2"; action: "contract_defect" }
  | { level: "L3"; action: "pause"; reason: PauseReason };

export function evaluateEscalation(
  state: EngineState,
  taskId: TaskId,
  failure: FailureClass,
  settings: Settings,
  taskClass: TaskClass = "feature",
): EscalationAction {
  if (failure === "permission_denied") {
    return {
      level: "L3",
      action: "pause",
      reason: "permission_denied",
    };
  }

  if (failure === "rate_limited") {
    return {
      level: "L3",
      action: "pause",
      reason: "rate_limited",
    };
  }

  const task = state.tasks[taskId] ?? {
    id: taskId,
    generation: 1,
    attempt: 1,
    state: "VERIFYING",
  };

  const attempt = task.attempt ?? 1;
  const generation = task.generation ?? 1;

  // L0 heal: only on first verify failure in current generation
  if (failure === "verify_failed" && attempt === 1) {
    return {
      level: "L0",
      action: "heal",
      session_id: task.session_id ?? "",
    };
  }

  // L1 replan check
  const maxL1Replans = settings.budgets.l1_replans_per_task ?? 2;
  if (generation <= maxL1Replans) {
    const nextGen = generation + 1;
    // The route comes from profile-slot precedence (DECISIONS A6); the ladder no
    // longer names a model or reads routing.feature directly.
    const route = resolveTaskRoute(taskClass, nextGen, settings);

    return {
      level: "L1",
      action: "replan",
      route,
      generation: nextGen,
    };
  }

  // L2 contract defect check
  const l2Count = (state as any).l2_count ?? 0;
  const maxL2 = settings.budgets.l2_per_run ?? 2;
  if (l2Count < maxL2) {
    return {
      level: "L2",
      action: "contract_defect",
    };
  }

  // L3 pause with needs_human
  return {
    level: "L3",
    action: "pause",
    reason: "needs_human",
  };
}
