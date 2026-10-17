import type {
  EngineEvent,
  FailureClass,
  PermissionMode,
  RunId,
  TaskId,
} from "../../contracts/index.js";
/* intra-tui */ import type { DialogState } from "./dialog.js";

export type { DialogState };

export interface TaskItemState {
  id: TaskId;
  state: string;
  generation: number;
  failureClass?: FailureClass;
}

export interface TuiRunState {
  runState: string;
  runId?: RunId;
  tasks: Record<TaskId, TaskItemState>;
  feed: EngineEvent[];
  feedVerbose: boolean;
  totalCostUsd: number;
  budgetCapUsd?: number;
  modelTier?: string;
}

export interface TuiState {
  prompt: string;
  history: string[];
  historyIndex: number;
  permissionMode: PermissionMode;
  run: TuiRunState;
  taskBoardVisible: boolean;
  dialog: DialogState;
  viewport: { cols: number; rows: number };
  banner?: string;
  exitArmed?: boolean;
  draft?: string;
}
