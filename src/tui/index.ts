/* intra-tui */ import type { TuiAction } from "./state/actions.js";
/* intra-tui */ import type { TuiState } from "./state/types.js";

/* intra-tui */ export * from "./state/types.js";
/* intra-tui */ export * from "./state/actions.js";
/* intra-tui */ export * from "./state/reducer.js";
/* intra-tui */ export * from "./state/dialog.js";
/* intra-tui */ export * from "./commands/types.js";
/* intra-tui */ export * from "./commands/registry.js";
/* intra-tui */ export * from "./keys/types.js";
/* intra-tui */ export * from "./keys/handler.js";

export type ViewportTier = "wide" | "medium" | "narrow" | "micro";
export type SegmentId = "model" | "state" | "tasks" | "cost" | "budget";

export interface StatusLineSegment {
  id: SegmentId;
  label: string;
  priority: number;
  minTerminalWidth: number;
}

export interface TuiAppProps {
  initialState?: TuiState;
  onExit?: (code: number) => void;
  onAction?: (action: TuiAction) => void;
}
