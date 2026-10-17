/* intra-tui */ import type { TuiAction } from "./state/actions.js";
/* intra-tui */ import { createInitialTuiState, reduceTuiState } from "./state/reducer.js";
/* intra-tui */ import type { TuiState } from "./state/types.js";
/* intra-tui */ import { formatStatusLineSegments, resolveViewportTier } from "./components/status-line.js";
/* intra-tui */ import { formatEventFeed } from "./components/event-feed.js";
/* intra-tui */ import { formatTaskBoard } from "./components/task-board.js";
/* intra-tui */ import { DialogOverlay } from "./components/dialogs.js";

export interface TuiAppProps {
  initialState?: TuiState;
  onExit?: (code: number) => void;
  onAction?: (action: TuiAction) => void;
}

export namespace React {
  export type FC<P = {}> = (props: P) => any;
}

export const SubstrateTuiApp: React.FC<TuiAppProps> = (props: TuiAppProps) => {
  let state = props.initialState ?? createInitialTuiState();

  const dispatch = (action: TuiAction) => {
    state = reduceTuiState(state, action);
    props.onAction?.(action);
    if (action.type === "EXIT") {
      props.onExit?.(action.code);
    }
  };

  const tier = resolveViewportTier(state.viewport.cols);
  const statusSegments = formatStatusLineSegments(state, tier);
  const feedLines = formatEventFeed(state.run.feed, state.run.feedVerbose);
  const taskLines = state.taskBoardVisible ? formatTaskBoard(state.run.tasks) : [];
  const dialogLines = DialogOverlay({ dialog: state.dialog });

  return {
    state,
    dispatch,
    render() {
      return {
        statusSegments,
        feedLines,
        taskLines,
        dialogLines,
        prompt: state.prompt,
        banner: state.banner,
      };
    },
  };
};
