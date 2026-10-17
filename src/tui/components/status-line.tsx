/* intra-tui */ import type { TuiState } from "../state/types.js";

export type ViewportTier = "wide" | "medium" | "narrow" | "micro";

export type SegmentId = "model" | "state" | "tasks" | "cost" | "budget";

export interface StatusLineSegment {
  id: SegmentId;
  label: string;
  priority: number;
  minTerminalWidth: number;
}

export function resolveViewportTier(cols: number): ViewportTier {
  if (cols >= 100) return "wide";
  if (cols >= 60) return "medium";
  if (cols >= 40) return "narrow";
  return "micro";
}

export function formatStatusLineSegments(
  state: TuiState,
  tier: ViewportTier
): string[] {
  if (tier === "micro") {
    const s = state.run.runState.toUpperCase();
    if (s === "EXECUTING") return ["[E]"];
    if (s === "PLANNING") return ["[P]"];
    if (s === "PAUSED" || s === "ERROR" || s === "FAILED") return ["[!]"];
    if (s === "FINISHED" || s === "IDLE" || s === "READY") return ["[OK]"];
    return [`[${s.charAt(0) || "!"}]`];
  }

  const runStateSegment = `[${state.run.runState}]`;
  const totalTasks = Object.keys(state.run.tasks).length;
  const doneTasks = Object.values(state.run.tasks).filter(
    (t) => t.state === "PASSED" || t.state === "MERGED"
  ).length;

  if (tier === "narrow") {
    const tasksSegment = `[${doneTasks}/${totalTasks}]`;
    return [runStateSegment, tasksSegment];
  }

  const tasksSegment = `[${doneTasks}/${totalTasks} tasks]`;
  const costStr =
    state.run.budgetCapUsd !== undefined
      ? `[$${state.run.totalCostUsd.toFixed(3)} / $${state.run.budgetCapUsd.toFixed(2)}]`
      : `[$${state.run.totalCostUsd.toFixed(3)}]`;

  if (tier === "medium") {
    return [runStateSegment, tasksSegment, costStr];
  }

  // tier === "wide"
  const modelSegment = `[${state.run.modelTier ?? "unknown"}]`;
  return [modelSegment, runStateSegment, tasksSegment, costStr];
}

export function StatusLine({ state }: { state: TuiState }): string {
  const tier = resolveViewportTier(state.viewport.cols);
  const segments = formatStatusLineSegments(state, tier);
  return segments.join(" ");
}
