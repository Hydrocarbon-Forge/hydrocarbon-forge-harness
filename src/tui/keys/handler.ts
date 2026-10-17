/* intra-tui */ import type { TuiAction } from "../state/actions.js";
/* intra-tui */ import type { TuiState } from "../state/types.js";
/* intra-tui */ import type { KeybindingDef, KeyContext, KeyEvent, KeyState } from "./types.js";

export const CANONICAL_KEYBINDINGS: readonly KeybindingDef[] = [
  {
    key: "Enter",
    action: "submit_prompt",
    description: "Submits prompt buffer to governor or deterministic run loop.",
    context: "prompt",
  },
  {
    key: "Esc",
    action: "interrupt_or_dismiss",
    description:
      "Graceful interrupt: pauses run with PAUSED(user_cancel), dismisses dialog, or clears prompt.",
    context: "global",
  },
  {
    key: "Shift+Tab",
    action: "cycle_permission_mode",
    description: "Cycles permission mode.",
    context: "prompt",
  },
  {
    key: "Ctrl+C",
    action: "exit_process",
    description:
      "Displays exit confirmation on first press; cleanly exits (code 130) if pressed within 500ms.",
    context: "global",
  },
  {
    key: "Ctrl+T",
    action: "toggle_task_board",
    description: "Toggles task board split pane between hidden and visible states.",
    context: "global",
  },
  {
    key: "Ctrl+O",
    action: "toggle_verbose_feed",
    description:
      "Toggles event feed verbosity between compact summary and expanded trace.",
    context: "global",
  },
  {
    key: "@",
    action: "mention_file",
    description: "Triggers file-mention autocompletion against workspace paths.",
    context: "prompt",
  },
  {
    key: "!",
    action: "shell_passthrough",
    description: "Prefixes trailing command to execute in local shell.",
    context: "prompt",
  },
];

export function getActiveKeyContext(state: TuiState): KeyContext {
  if (state.dialog && state.dialog.type !== "none") {
    return "dialog";
  }
  if (
    ["EXECUTING", "PLANNING", "VERIFYING", "INTEGRATING"].includes(
      state.run.runState
    )
  ) {
    return "running";
  }
  return "prompt";
}

export function handleKeyPress(
  key: KeyEvent,
  state: TuiState,
  keyState: KeyState,
  now?: number
): TuiAction[] {
  const currentTime = now ?? Date.now();

  // Ctrl+C handling (global)
  if (key.ctrl && key.name.toLowerCase() === "c") {
    if (
      state.exitArmed &&
      keyState.lastCtrlCTime !== undefined &&
      currentTime - keyState.lastCtrlCTime <= 500
    ) {
      keyState.lastCtrlCTime = undefined;
      return [{ type: "EXIT", code: 130 }];
    } else {
      keyState.lastCtrlCTime = currentTime;
      return [{ type: "INTERRUPT_PRESS", timestamp: currentTime }];
    }
  }

  const context = getActiveKeyContext(state);

  if (context === "dialog") {
    const isEnter = key.name === "return" || key.name === "enter";
    const isEsc = key.name === "escape";

    if (isEnter) {
      if (
        state.dialog.type === "approval_plan" ||
        state.dialog.type === "approval_cost" ||
        state.dialog.type === "approval_merge"
      ) {
        return [{ type: "APPROVE_GATE", approved: true }];
      }
      if (state.dialog.type === "session_picker") {
        const session = state.dialog.sessions[state.dialog.selectedIndex];
        return session !== undefined
          ? [{ type: "SELECT_SESSION", sessionId: session }]
          : [{ type: "CLOSE_DIALOG" }];
      }
    }

    if (isEsc) {
      if (
        state.dialog.type === "approval_plan" ||
        state.dialog.type === "approval_cost" ||
        state.dialog.type === "approval_merge"
      ) {
        return [{ type: "APPROVE_GATE", approved: false }];
      }
      if (state.dialog.type === "session_picker") {
        return [{ type: "CLOSE_DIALOG" }];
      }
    }

    return [];
  }

  if (context === "running") {
    if (key.ctrl && key.name.toLowerCase() === "t") {
      return [{ type: "TOGGLE_TASK_BOARD" }];
    }
    if (key.ctrl && key.name.toLowerCase() === "o") {
      return [{ type: "TOGGLE_VERBOSE_FEED" }];
    }
    if (key.name === "escape") {
      if (
        keyState.lastEscTime !== undefined &&
        currentTime - keyState.lastEscTime < 200
      ) {
        return [];
      }
      keyState.lastEscTime = currentTime;
      return [
        {
          type: "ENGINE_EVENT",
          event: {
            v: 1,
            seq: 0,
            ts: new Date(currentTime).toISOString(),
            run_id: state.run.runId ?? ("" as any),
            type: "run.paused",
            data: { reason: "user_cancel" },
          },
        },
      ];
    }
    return [];
  }

  // context === "prompt"
  if (key.ctrl && key.name.toLowerCase() === "t") {
    return [{ type: "TOGGLE_TASK_BOARD" }];
  }
  if (key.ctrl && key.name.toLowerCase() === "o") {
    return [{ type: "TOGGLE_VERBOSE_FEED" }];
  }
  if (key.shift && (key.name === "tab" || key.name === "backtab")) {
    return [{ type: "CYCLE_PERMISSION_MODE" }];
  }
  if (key.name === "escape") {
    if (state.prompt.length > 0) {
      return [{ type: "PROMPT_CLEAR" }];
    }
    return [];
  }
  if (key.name === "return" || key.name === "enter") {
    if (!state.prompt.trim()) {
      return [];
    }
    return [{ type: "INPUT_SUBMIT" }];
  }
  if (key.name === "up") {
    return [{ type: "HISTORY_PREV" }];
  }
  if (key.name === "down") {
    return [{ type: "HISTORY_NEXT" }];
  }

  return [];
}
