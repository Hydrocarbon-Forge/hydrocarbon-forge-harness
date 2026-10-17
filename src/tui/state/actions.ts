import type { EngineEvent, SessionId } from "../../contracts/index.js";
/* intra-tui */ import type { DialogState } from "./dialog.js";

export type TuiUserAction =
  | { type: "INPUT_CHANGE"; text: string }
  | { type: "INPUT_SUBMIT" }
  | { type: "CYCLE_PERMISSION_MODE" }
  | { type: "TOGGLE_TASK_BOARD" }
  | { type: "TOGGLE_VERBOSE_FEED" }
  | { type: "PROMPT_CLEAR" }
  | { type: "HISTORY_PREV" }
  | { type: "HISTORY_NEXT" }
  | { type: "INTERRUPT_PRESS"; timestamp: number }
  | { type: "SIGWINCH"; cols: number; rows: number };

export type TuiControlAction =
  | { type: "ENGINE_EVENT"; event: EngineEvent }
  | { type: "OPEN_DIALOG"; dialog: DialogState }
  | { type: "CLOSE_DIALOG" }
  | { type: "APPROVE_GATE"; approved: boolean }
  | { type: "SELECT_SESSION"; sessionId: SessionId }
  | { type: "DISPATCH_SLASH"; command: string; args: string }
  | { type: "SHELL_PASSTHROUGH"; command: string }
  | { type: "SET_BANNER"; message?: string }
  | { type: "EXIT"; code: number };

export type TuiAction = TuiUserAction | TuiControlAction;
