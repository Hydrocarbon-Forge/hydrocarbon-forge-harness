import type { PermissionMode } from "../../contracts/index.js";
/* intra-tui */ import type { TuiAction } from "./actions.js";
/* intra-tui */ import type { TaskItemState, TuiState } from "./types.js";

const MODE_CYCLE_ORDER: Record<PermissionMode, PermissionMode> = {
  default: "plan",
  plan: "acceptEdits",
  acceptEdits: "dontAsk",
  dontAsk: "bypassPermissions",
  bypassPermissions: "default",
};

export function createInitialTuiState(
  cols = 80,
  rows = 24,
  initialMode: PermissionMode = "default"
): TuiState {
  return {
    prompt: "",
    history: [],
    historyIndex: -1,
    permissionMode: initialMode,
    run: {
      runState: "IDLE",
      tasks: {},
      feed: [],
      feedVerbose: false,
      totalCostUsd: 0,
      budgetCapUsd: 5.0,
      modelTier: "sonnet/medium",
    },
    taskBoardVisible: false,
    dialog: { type: "none" },
    viewport: { cols, rows },
    banner: undefined,
    exitArmed: false,
  };
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "INPUT_CHANGE":
      return {
        ...state,
        prompt: action.text,
      };

    case "INPUT_SUBMIT": {
      if (!state.prompt.trim()) {
        return state;
      }
      return {
        ...state,
        prompt: "",
        history: [...state.history, state.prompt],
        historyIndex: -1,
        draft: undefined,
      };
    }

    case "PROMPT_CLEAR":
      return {
        ...state,
        prompt: "",
        draft: undefined,
      };

    case "HISTORY_PREV": {
      if (state.history.length === 0) {
        return state;
      }
      if (state.historyIndex === -1) {
        const nextIndex = state.history.length - 1;
        return {
          ...state,
          draft: state.prompt,
          historyIndex: nextIndex,
          prompt: state.history[nextIndex],
        };
      }
      if (state.historyIndex > 0) {
        const nextIndex = state.historyIndex - 1;
        return {
          ...state,
          historyIndex: nextIndex,
          prompt: state.history[nextIndex],
        };
      }
      return state;
    }

    case "HISTORY_NEXT": {
      if (state.historyIndex === -1) {
        return state;
      }
      if (state.historyIndex < state.history.length - 1) {
        const nextIndex = state.historyIndex + 1;
        return {
          ...state,
          historyIndex: nextIndex,
          prompt: state.history[nextIndex],
        };
      }
      return {
        ...state,
        historyIndex: -1,
        prompt: state.draft ?? "",
        draft: undefined,
      };
    }

    case "CYCLE_PERMISSION_MODE": {
      if (state.dialog.type !== "none") {
        return state;
      }
      const nextMode = MODE_CYCLE_ORDER[state.permissionMode] ?? "default";
      return {
        ...state,
        permissionMode: nextMode,
      };
    }

    case "TOGGLE_TASK_BOARD": {
      if (state.dialog.type !== "none") {
        return state;
      }
      return {
        ...state,
        taskBoardVisible: !state.taskBoardVisible,
      };
    }

    case "TOGGLE_VERBOSE_FEED": {
      if (state.dialog.type !== "none") {
        return state;
      }
      return {
        ...state,
        run: {
          ...state.run,
          feedVerbose: !state.run.feedVerbose,
        },
      };
    }

    case "INTERRUPT_PRESS":
      return {
        ...state,
        exitArmed: true,
        banner: "Press Ctrl+C again to exit",
      };

    case "SIGWINCH":
      return {
        ...state,
        viewport: { cols: action.cols, rows: action.rows },
      };

    case "ENGINE_EVENT": {
      const event = action.event;
      let nextRunState = state.run.runState;
      let nextRunId = event.run_id ?? state.run.runId;
      const nextTasks: Record<string, TaskItemState> = { ...state.run.tasks };
      let nextCost = state.run.totalCostUsd;

      if (event.type === "run.state") {
        const data = event.data as { state?: string } | undefined;
        if (data?.state) {
          nextRunState = data.state;
        }
      } else if (event.type === "run.paused") {
        nextRunState = "PAUSED";
      } else if (event.type === "run.finished") {
        nextRunState = "FINISHED";
      } else if (event.type === "task.ready") {
        const data = event.data as { task_id: string; generation?: number };
        nextTasks[data.task_id] = {
          id: data.task_id,
          state: "READY",
          generation: data.generation ?? 1,
        };
      } else if (event.type === "task.verify.started") {
        const data = event.data as { task_id: string; generation?: number };
        const prev = nextTasks[data.task_id];
        nextTasks[data.task_id] = {
          ...prev,
          id: data.task_id,
          state: "VERIFYING",
          generation: data.generation ?? prev?.generation ?? 1,
        };
      } else if (event.type === "task.passed") {
        const data = event.data as { task_id: string; generation?: number };
        const prev = nextTasks[data.task_id];
        nextTasks[data.task_id] = {
          ...prev,
          id: data.task_id,
          state: "PASSED",
          generation: data.generation ?? prev?.generation ?? 1,
        };
      } else if (event.type === "task.failed") {
        const data = event.data as { task_id: string; generation?: number; failure_class?: any };
        const prev = nextTasks[data.task_id];
        nextTasks[data.task_id] = {
          ...prev,
          id: data.task_id,
          state: "FAILED",
          generation: data.generation ?? prev?.generation ?? 1,
          failureClass: data.failure_class,
        };
      } else if (event.type === "task.merged") {
        const data = event.data as { task_id: string; generation?: number };
        const prev = nextTasks[data.task_id];
        nextTasks[data.task_id] = {
          ...prev,
          id: data.task_id,
          state: "MERGED",
          generation: data.generation ?? prev?.generation ?? 1,
        };
      } else if (event.type === "usage.recorded") {
        const data = event.data as { record?: { cost_usd?: number }; cost_usd?: number } | undefined;
        const addCost = data?.record?.cost_usd ?? data?.cost_usd ?? 0;
        nextCost = state.run.totalCostUsd + addCost;
      }

      return {
        ...state,
        run: {
          ...state.run,
          runState: nextRunState,
          runId: nextRunId,
          tasks: nextTasks,
          totalCostUsd: nextCost,
          feed: [...state.run.feed, event],
        },
      };
    }

    case "OPEN_DIALOG":
      return {
        ...state,
        dialog: action.dialog,
      };

    case "CLOSE_DIALOG":
    case "APPROVE_GATE":
      return {
        ...state,
        dialog: { type: "none" },
      };

    case "SELECT_SESSION":
      return {
        ...state,
        dialog: { type: "none" },
      };

    case "DISPATCH_SLASH":
    case "SHELL_PASSTHROUGH":
      return state;

    case "SET_BANNER":
      return {
        ...state,
        banner: action.message,
      };

    case "EXIT":
      return {
        ...state,
        exitArmed: false,
        banner: undefined,
      };

    default:
      return state;
  }
}
