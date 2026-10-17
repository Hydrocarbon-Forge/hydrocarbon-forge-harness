import { describe, expect, it } from "vitest";

import type * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import type { DialogState, TuiAction, TuiState } from "./reducer.test.js";

export type KeyContext = "prompt" | "running" | "dialog" | "global";

export interface KeybindingDef {
  key: string;
  action: string;
  description: string;
  context: KeyContext;
}

export interface KeyState {
  lastCtrlCTime?: number;
  lastEscTime?: number;
}

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

async function loadKeysModule(): Promise<{
  handleKeyPress: (
    key: KeyEvent,
    state: TuiState,
    keyState: KeyState,
    now?: number
  ) => TuiAction[];
  getActiveKeyContext: (state: TuiState) => KeyContext;
  CANONICAL_KEYBINDINGS: readonly KeybindingDef[];
}> {
  return (await import("../../../src/tui/keys/handler.js" as any)) as any;
}

function makeMockState(overrides?: Partial<TuiState>): TuiState {
  return {
    prompt: "",
    history: [],
    historyIndex: -1,
    permissionMode: "default",
    run: {
      runState: "IDLE",
      tasks: {},
      feed: [],
      feedVerbose: false,
      totalCostUsd: 0,
      budgetCapUsd: 2.0,
      modelTier: "claude-sonnet-5-5",
    },
    taskBoardVisible: false,
    dialog: { type: "none" },
    viewport: { cols: 80, rows: 24 },
    exitArmed: false,
    banner: undefined,
    ...overrides,
  };
}

describe("keybinding handler & state machine (P5.3)", () => {
  describe("getActiveKeyContext context resolution", () => {
    it("identifies 'dialog' context whenever an active modal dialog is present", async () => {
      const { getActiveKeyContext } = await loadKeysModule();
      const runId = createRunId();

      const stateWithCostDialog = makeMockState({
        dialog: { type: "approval_cost", estimatedUsd: 3.0, thresholdUsd: 1.5 },
      });
      expect(getActiveKeyContext(stateWithCostDialog)).toBe("dialog");

      const stateWithPlanDialog = makeMockState({
        dialog: {
          type: "approval_plan",
          manifest: {
            version: 1,
            run_id: runId,
            goal: "test",
            base_ref: "main",
            setup: [],
            contracts: { files: [], typecheck: [] },
            integration_verify: [],
            tasks: [],
          },
        },
      });
      expect(getActiveKeyContext(stateWithPlanDialog)).toBe("dialog");

      const stateWithPicker = makeMockState({
        dialog: { type: "session_picker", sessions: ["s1", "s2"], selectedIndex: 0 },
      });
      expect(getActiveKeyContext(stateWithPicker)).toBe("dialog");
    });

    it("identifies 'running' context when no dialog is active and execution is in flight", async () => {
      const { getActiveKeyContext } = await loadKeysModule();
      const runningStates = ["EXECUTING", "PLANNING", "VERIFYING", "INTEGRATING"];

      for (const st of runningStates) {
        const state = makeMockState({
          run: { ...makeMockState().run, runState: st },
          dialog: { type: "none" },
        });
        expect(getActiveKeyContext(state)).toBe("running");
      }
    });

    it("identifies 'prompt' context when idle, ready, or paused with no dialog open", async () => {
      const { getActiveKeyContext } = await loadKeysModule();
      const idleStates = ["IDLE", "READY", "PAUSED", "FINISHED"];

      for (const st of idleStates) {
        const state = makeMockState({
          run: { ...makeMockState().run, runState: st },
          dialog: { type: "none" },
        });
        expect(getActiveKeyContext(state)).toBe("prompt");
      }
    });
  });

  describe("Enter key submission behavior", () => {
    it("submits non-empty prompt in prompt context", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ prompt: "Fix authentication token issue" });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "return", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "INPUT_SUBMIT" }]);
    });

    it("ignores Enter when prompt buffer is empty or only whitespace", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const emptyState = makeMockState({ prompt: "" });
      const whitespaceState = makeMockState({ prompt: "   \t  " });
      const keyState: KeyState = {};

      const emptyActions = handleKeyPress(
        { name: "return", ctrl: false, shift: false, meta: false },
        emptyState,
        keyState,
        1000
      );
      expect(emptyActions).toEqual([]);

      const whitespaceActions = handleKeyPress(
        { name: "return", ctrl: false, shift: false, meta: false },
        whitespaceState,
        keyState,
        1000
      );
      expect(whitespaceActions).toEqual([]);
    });

    it("approves gate in approval dialogs when Enter is pressed", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        dialog: { type: "approval_cost", estimatedUsd: 1.5, thresholdUsd: 1.0 },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "return", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "APPROVE_GATE", approved: true }]);
    });

    it("selects active session in session picker when Enter is pressed", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        dialog: {
          type: "session_picker",
          sessions: ["sess_123", "sess_456"],
          selectedIndex: 1,
        },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "return", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "SELECT_SESSION", sessionId: "sess_456" }]);
    });
  });

  describe("Shift+Tab permission mode cycling", () => {
    it("dispatches CYCLE_PERMISSION_MODE when pressed in prompt context", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ dialog: { type: "none" } });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "tab", ctrl: false, shift: true, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "CYCLE_PERMISSION_MODE" }]);
    });

    it("ignores Shift+Tab when a modal dialog is active", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        dialog: { type: "approval_cost", estimatedUsd: 2.0, thresholdUsd: 1.0 },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "tab", ctrl: false, shift: true, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([]);
    });
  });

  describe("Esc key context-aware semantics", () => {
    it("dismisses or rejects approval dialog on Esc", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        dialog: { type: "approval_cost", estimatedUsd: 2.5, thresholdUsd: 1.0 },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "escape", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions.some((a) => a.type === "APPROVE_GATE" || a.type === "CLOSE_DIALOG")).toBe(
        true
      );
    });

    it("closes session picker dialog on Esc", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        dialog: { type: "session_picker", sessions: ["s1"], selectedIndex: 0 },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "escape", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "CLOSE_DIALOG" }]);
    });

    it("requests graceful engine pause when Esc is pressed during active run", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        run: { ...makeMockState().run, runState: "EXECUTING" },
        dialog: { type: "none" },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "escape", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions.length).toBeGreaterThan(0);
      expect(
        actions.some(
          (a) =>
            a.type === "ENGINE_EVENT" ||
            a.type === "SET_BANNER" ||
            (a as any).type === "REQUEST_PAUSE"
        )
      ).toBe(true);
    });

    it("debounces rapid successive Esc spam during execution to maintain idempotency", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        run: { ...makeMockState().run, runState: "EXECUTING" },
        dialog: { type: "none" },
      });
      const keyState: KeyState = { lastEscTime: 1000 };

      // Rapid follow-up at 1050ms (< 200ms debouncing window)
      const actions = handleKeyPress(
        { name: "escape", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1050
      );

      expect(actions).toEqual([]);
    });

    it("dispatches PROMPT_CLEAR on Esc when unsubmitted text is in prompt buffer", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        prompt: "partially drafted command",
        run: { ...makeMockState().run, runState: "IDLE" },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "escape", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "PROMPT_CLEAR" }]);
    });

    it("ignores Esc in prompt context when buffer is already empty (no-op)", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        prompt: "",
        run: { ...makeMockState().run, runState: "IDLE" },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "escape", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([]);
    });
  });

  describe("Ctrl+C double-tap state machine (500ms debounce window)", () => {
    it("arms exit and records timestamp on first Ctrl+C press", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState();
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "c", ctrl: true, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions.some((a) => a.type === "INTERRUPT_PRESS" || a.type === "SET_BANNER")).toBe(
        true
      );
      expect(keyState.lastCtrlCTime).toBe(1000);
      expect(actions.some((a) => a.type === "EXIT")).toBe(false);
    });

    it("emits EXIT with code 130 on second Ctrl+C within 500ms", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ exitArmed: true });
      const keyState: KeyState = { lastCtrlCTime: 1000 };

      // Second press at t=1350ms (350ms elapsed <= 500ms)
      const actions = handleKeyPress(
        { name: "c", ctrl: true, shift: false, meta: false },
        state,
        keyState,
        1350
      );

      expect(actions).toEqual([{ type: "EXIT", code: 130 }]);
    });

    it("resets and re-arms interrupt without exiting if second Ctrl+C arrives after > 500ms", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ exitArmed: true });
      const keyState: KeyState = { lastCtrlCTime: 1000 };

      // Second press at t=1550ms (550ms elapsed > 500ms window)
      const actions = handleKeyPress(
        { name: "c", ctrl: true, shift: false, meta: false },
        state,
        keyState,
        1550
      );

      expect(actions.some((a) => a.type === "EXIT")).toBe(false);
      expect(actions.some((a) => a.type === "INTERRUPT_PRESS" || a.type === "SET_BANNER")).toBe(
        true
      );
      expect(keyState.lastCtrlCTime).toBe(1550);
    });
  });

  describe("Pane toggle shortcuts (Ctrl+T and Ctrl+O)", () => {
    it("dispatches TOGGLE_TASK_BOARD on Ctrl+T in non-dialog context", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ dialog: { type: "none" } });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "t", ctrl: true, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "TOGGLE_TASK_BOARD" }]);
    });

    it("ignores Ctrl+T when modal dialog is open", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        dialog: { type: "approval_cost", estimatedUsd: 1, thresholdUsd: 0.5 },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "t", ctrl: true, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([]);
    });

    it("dispatches TOGGLE_VERBOSE_FEED on Ctrl+O in non-dialog context", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ dialog: { type: "none" } });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "o", ctrl: true, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "TOGGLE_VERBOSE_FEED" }]);
    });

    it("ignores Ctrl+O when modal dialog is open", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({
        dialog: { type: "approval_cost", estimatedUsd: 1, thresholdUsd: 0.5 },
      });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "o", ctrl: true, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([]);
    });
  });

  describe("Arrow key prompt history navigation", () => {
    it("dispatches HISTORY_PREV on Up arrow in prompt context", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ dialog: { type: "none" } });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "up", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "HISTORY_PREV" }]);
    });

    it("dispatches HISTORY_NEXT on Down arrow in prompt context", async () => {
      const { handleKeyPress } = await loadKeysModule();
      const state = makeMockState({ dialog: { type: "none" } });
      const keyState: KeyState = {};

      const actions = handleKeyPress(
        { name: "down", ctrl: false, shift: false, meta: false },
        state,
        keyState,
        1000
      );

      expect(actions).toEqual([{ type: "HISTORY_NEXT" }]);
    });
  });
});
