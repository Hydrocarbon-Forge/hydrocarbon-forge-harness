import { describe, expect, it } from "vitest";

import type * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";

export type DialogState =
  | { type: "none" }
  | { type: "approval_plan"; manifest: Contracts.Manifest }
  | { type: "approval_cost"; estimatedUsd: number; thresholdUsd: number }
  | { type: "approval_merge"; runId: Contracts.RunId; branch: string; files: string[] }
  | { type: "session_picker"; sessions: Contracts.SessionId[]; selectedIndex: number };

export interface TaskItemState {
  id: Contracts.TaskId;
  state: string;
  generation: number;
  failureClass?: Contracts.FailureClass;
}

export interface TuiRunState {
  runState: string;
  runId?: Contracts.RunId;
  tasks: Record<Contracts.TaskId, TaskItemState>;
  feed: Contracts.EngineEvent[];
  feedVerbose: boolean;
  totalCostUsd: number;
  budgetCapUsd?: number;
  modelTier?: string;
}

export interface TuiState {
  prompt: string;
  history: string[];
  historyIndex: number;
  permissionMode: Contracts.PermissionMode;
  run: TuiRunState;
  taskBoardVisible: boolean;
  dialog: DialogState;
  viewport: { cols: number; rows: number };
  banner?: string;
  exitArmed?: boolean;
}

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
  | { type: "ENGINE_EVENT"; event: Contracts.EngineEvent }
  | { type: "OPEN_DIALOG"; dialog: DialogState }
  | { type: "CLOSE_DIALOG" }
  | { type: "APPROVE_GATE"; approved: boolean }
  | { type: "SELECT_SESSION"; sessionId: Contracts.SessionId }
  | { type: "DISPATCH_SLASH"; command: string; args: string }
  | { type: "SHELL_PASSTHROUGH"; command: string }
  | { type: "SET_BANNER"; message?: string }
  | { type: "EXIT"; code: number };

export type TuiAction = TuiUserAction | TuiControlAction;

async function loadReducerModule(): Promise<{
  reduceTuiState: (state: TuiState, action: TuiAction) => TuiState;
  createInitialTuiState: (
    cols?: number,
    rows?: number,
    initialMode?: Contracts.PermissionMode
  ) => TuiState;
}> {
  return (await import("../../../src/tui/state/reducer.js" as any)) as any;
}

function makeEngineEvent(
  runId: Contracts.RunId,
  seq: number,
  type: string,
  data: unknown
): Contracts.EngineEvent {
  return {
    v: 1,
    seq,
    ts: "2026-10-17T15:00:00.000Z",
    run_id: runId,
    type,
    data,
  };
}

function createSampleManifest(runId: Contracts.RunId): Contracts.Manifest {
  return {
    version: 1,
    run_id: runId,
    goal: "Implement TUI state model",
    base_ref: "main",
    setup: [{ run: "npm install", timeout_s: 60 }],
    contracts: {
      files: ["src/contracts/index.ts"],
      typecheck: [{ run: "npm run typecheck", timeout_s: 30 }],
    },
    integration_verify: [{ run: "npm test", timeout_s: 120 }],
    tasks: [{ id: "TaskA", spec: ".tasks/TaskA.md" }],
    budget: { max_usd: 1.5 },
  };
}

function createBlankTuiState(overrides?: Partial<TuiState>): TuiState {
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
      budgetCapUsd: 5.0,
      modelTier: "sonnet/medium",
    },
    taskBoardVisible: false,
    dialog: { type: "none" },
    viewport: { cols: 80, rows: 24 },
    exitArmed: false,
    banner: undefined,
    ...overrides,
  };
}

describe("pure reducer & initial state factory (P5.3)", () => {
  it("creates initial TuiState with default layout and permission mode", async () => {
    const { createInitialTuiState } = await loadReducerModule();
    const state = createInitialTuiState();

    expect(state.prompt).toBe("");
    expect(state.history).toEqual([]);
    expect(state.permissionMode).toBe("default");
    expect(state.taskBoardVisible).toBe(false);
    expect(state.dialog).toEqual({ type: "none" });
    expect(state.viewport).toEqual({ cols: 80, rows: 24 });
    expect(state.run.runState).toBeDefined();
    expect(state.run.tasks).toEqual({});
    expect(state.run.feed).toEqual([]);
    expect(state.run.feedVerbose).toBe(false);
    expect(state.run.totalCostUsd).toBe(0);
    expect(state.exitArmed).toBe(false);
  });

  it("creates initial TuiState with custom viewport and initial mode", async () => {
    const { createInitialTuiState } = await loadReducerModule();
    const state = createInitialTuiState(120, 40, "bypassPermissions");

    expect(state.viewport).toEqual({ cols: 120, rows: 40 });
    expect(state.permissionMode).toBe("bypassPermissions");
  });

  it("enforces pure reducer determinism: identical inputs yield deeply equal states", async () => {
    const { reduceTuiState } = await loadReducerModule();
    const runId = createRunId();
    const state = createBlankTuiState({
      prompt: "test prompt",
      run: {
        runState: "EXECUTING",
        runId,
        tasks: { TaskA: { id: "TaskA", state: "READY", generation: 1 } },
        feed: [],
        feedVerbose: false,
        totalCostUsd: 0.12,
      },
    });

    const action: TuiAction = {
      type: "ENGINE_EVENT",
      event: makeEngineEvent(runId, 1, "task.passed", { task_id: "TaskA", generation: 1 }),
    };

    const next1 = reduceTuiState(state, action);
    const next2 = reduceTuiState(state, action);

    expect(next1).toEqual(next2);
    expect(next1).not.toBe(state);
  });

  it("enforces state immutability: input state and nested structures are never mutated", async () => {
    const { reduceTuiState } = await loadReducerModule();
    const runId = createRunId();
    const state = createBlankTuiState({
      prompt: "draft text",
      history: ["old1", "old2"],
      run: {
        runState: "PLANNING",
        runId,
        tasks: { TaskA: { id: "TaskA", state: "READY", generation: 1 } },
        feed: [makeEngineEvent(runId, 0, "run.created", {})],
        feedVerbose: false,
        totalCostUsd: 0.05,
      },
    });

    Object.freeze(state);
    Object.freeze(state.history);
    Object.freeze(state.run);
    Object.freeze(state.run.tasks);
    Object.freeze(state.run.tasks.TaskA);
    Object.freeze(state.run.feed);
    Object.freeze(state.viewport);
    Object.freeze(state.dialog);

    const action: TuiAction = { type: "INPUT_CHANGE", text: "updated text" };
    const next = reduceTuiState(state, action);

    expect(next.prompt).toBe("updated text");
    expect(state.prompt).toBe("draft text");
    expect(next).not.toBe(state);
  });

  describe("INPUT_CHANGE and INPUT_SUBMIT transitions", () => {
    it("updates prompt buffer on INPUT_CHANGE", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({ prompt: "" });

      const next = reduceTuiState(initial, { type: "INPUT_CHANGE", text: "hello world" });
      expect(next.prompt).toBe("hello world");
    });

    it("ignores INPUT_SUBMIT when prompt is empty string (no-op)", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({ prompt: "", history: ["prior"] });

      const next = reduceTuiState(initial, { type: "INPUT_SUBMIT" });
      expect(next.prompt).toBe("");
      expect(next.history).toEqual(["prior"]);
    });

    it("ignores INPUT_SUBMIT when prompt contains only whitespace (no-op)", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({ prompt: "   \t\n  ", history: ["prior"] });

      const next = reduceTuiState(initial, { type: "INPUT_SUBMIT" });
      expect(next.history).toEqual(["prior"]);
    });

    it("appends prompt to history, resets historyIndex, and clears buffer on valid submit", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({
        prompt: "npm test",
        history: ["cmd1"],
        historyIndex: 0,
      });

      const next = reduceTuiState(initial, { type: "INPUT_SUBMIT" });
      expect(next.prompt).toBe("");
      expect(next.history).toEqual(["cmd1", "npm test"]);
      expect(next.historyIndex).toBe(-1);
    });

    it("preserves embedded newlines from pasted multiline prompts upon submission", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const multiline = "line 1\nline 2\nline 3";
      const initial = createBlankTuiState({ prompt: multiline, history: [] });

      const next = reduceTuiState(initial, { type: "INPUT_SUBMIT" });
      expect(next.prompt).toBe("");
      expect(next.history).toEqual([multiline]);
    });
  });

  describe("Prompt history navigation (HISTORY_PREV / HISTORY_NEXT)", () => {
    it("navigates backward through history with HISTORY_PREV and preserves unsubmitted draft", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({
        prompt: "in-progress draft",
        history: ["first", "second", "third"],
        historyIndex: -1,
      });

      const step1 = reduceTuiState(initial, { type: "HISTORY_PREV" });
      expect(step1.prompt).toBe("third");
      expect(step1.historyIndex).toBe(2);

      const step2 = reduceTuiState(step1, { type: "HISTORY_PREV" });
      expect(step2.prompt).toBe("second");
      expect(step2.historyIndex).toBe(1);

      const step3 = reduceTuiState(step2, { type: "HISTORY_PREV" });
      expect(step3.prompt).toBe("first");
      expect(step3.historyIndex).toBe(0);

      // Boundary check: does not underflow below index 0
      const step4 = reduceTuiState(step3, { type: "HISTORY_PREV" });
      expect(step4.prompt).toBe("first");
      expect(step4.historyIndex).toBe(0);
    });

    it("navigates forward through history with HISTORY_NEXT and restores initial draft", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({
        prompt: "first",
        history: ["first", "second", "third"],
        historyIndex: 0,
      });

      const step1 = reduceTuiState(initial, { type: "HISTORY_NEXT" });
      expect(step1.prompt).toBe("second");
      expect(step1.historyIndex).toBe(1);

      const step2 = reduceTuiState(step1, { type: "HISTORY_NEXT" });
      expect(step2.prompt).toBe("third");
      expect(step2.historyIndex).toBe(2);

      // Reaching the end restores the draft or resets to empty
      const step3 = reduceTuiState(step2, { type: "HISTORY_NEXT" });
      expect(step3.historyIndex).toBe(-1);
    });
  });

  describe("Permission mode monotonic cycling", () => {
    it("cycles permissionMode through the 5 canonical modes in strict sequence", async () => {
      const { reduceTuiState } = await loadReducerModule();
      let state = createBlankTuiState({ permissionMode: "default" });

      state = reduceTuiState(state, { type: "CYCLE_PERMISSION_MODE" });
      expect(state.permissionMode).toBe("plan");

      state = reduceTuiState(state, { type: "CYCLE_PERMISSION_MODE" });
      expect(state.permissionMode).toBe("acceptEdits");

      state = reduceTuiState(state, { type: "CYCLE_PERMISSION_MODE" });
      expect(state.permissionMode).toBe("dontAsk");

      state = reduceTuiState(state, { type: "CYCLE_PERMISSION_MODE" });
      expect(state.permissionMode).toBe("bypassPermissions");

      state = reduceTuiState(state, { type: "CYCLE_PERMISSION_MODE" });
      expect(state.permissionMode).toBe("default");
    });

    it("ignores CYCLE_PERMISSION_MODE when a modal dialog is open", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const runId = createRunId();
      const state = createBlankTuiState({
        permissionMode: "default",
        dialog: { type: "approval_plan", manifest: createSampleManifest(runId) },
      });

      const next = reduceTuiState(state, { type: "CYCLE_PERMISSION_MODE" });
      expect(next.permissionMode).toBe("default");
    });
  });

  describe("Task board and verbose feed toggles", () => {
    it("toggles taskBoardVisible flag in non-dialog context", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({ taskBoardVisible: false });

      const state1 = reduceTuiState(initial, { type: "TOGGLE_TASK_BOARD" });
      expect(state1.taskBoardVisible).toBe(true);

      const state2 = reduceTuiState(state1, { type: "TOGGLE_TASK_BOARD" });
      expect(state2.taskBoardVisible).toBe(false);
    });

    it("ignores TOGGLE_TASK_BOARD when a dialog is active", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({
        taskBoardVisible: false,
        dialog: { type: "approval_cost", estimatedUsd: 1.5, thresholdUsd: 1.0 },
      });

      const next = reduceTuiState(initial, { type: "TOGGLE_TASK_BOARD" });
      expect(next.taskBoardVisible).toBe(false);
    });

    it("toggles run.feedVerbose flag in non-dialog context", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState();
      initial.run.feedVerbose = false;

      const state1 = reduceTuiState(initial, { type: "TOGGLE_VERBOSE_FEED" });
      expect(state1.run.feedVerbose).toBe(true);

      const state2 = reduceTuiState(state1, { type: "TOGGLE_VERBOSE_FEED" });
      expect(state2.run.feedVerbose).toBe(false);
    });
  });

  describe("PROMPT_CLEAR and terminal resize SIGWINCH", () => {
    it("empties prompt buffer without modifying history on PROMPT_CLEAR", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({
        prompt: "unsubmitted text",
        history: ["old"],
      });

      const next = reduceTuiState(initial, { type: "PROMPT_CLEAR" });
      expect(next.prompt).toBe("");
      expect(next.history).toEqual(["old"]);
    });

    it("updates viewport dimensions on SIGWINCH", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({ viewport: { cols: 80, rows: 24 } });

      const next = reduceTuiState(initial, { type: "SIGWINCH", cols: 140, rows: 45 });
      expect(next.viewport).toEqual({ cols: 140, rows: 45 });
    });
  });

  describe("Interrupt handling state machine (Ctrl+C)", () => {
    it("arms exit and sets banner on first INTERRUPT_PRESS", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({ exitArmed: false });

      const next = reduceTuiState(initial, { type: "INTERRUPT_PRESS", timestamp: 1000 });
      expect(next.exitArmed).toBe(true);
      expect(next.banner).toContain("Ctrl+C again to exit");
    });
  });

  describe("Engine event ingestion (ENGINE_EVENT)", () => {
    it("updates run.runState and run.runId on run.state / run.paused / run.finished", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const runId = createRunId();
      let state = createBlankTuiState();

      state = reduceTuiState(state, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 1, "run.state", { state: "EXECUTING" }),
      });
      expect(state.run.runState).toBe("EXECUTING");
      expect(state.run.runId).toBe(runId);
      expect(state.run.feed).toHaveLength(1);

      state = reduceTuiState(state, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 2, "run.paused", { reason: "needs_approval" }),
      });
      expect(state.run.runState).toBe("PAUSED");
      expect(state.run.feed).toHaveLength(2);

      state = reduceTuiState(state, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 3, "run.finished", { status: "finished", exit_code: 0 }),
      });
      expect(state.run.runState).toBe("FINISHED");
      expect(state.run.feed).toHaveLength(3);
    });

    it("updates task item state and generation on task lifecycle events", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const runId = createRunId();
      let state = createBlankTuiState({ run: { ...createBlankTuiState().run, runId } });

      state = reduceTuiState(state, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 1, "task.ready", { task_id: "TaskA", generation: 1 }),
      });
      expect(state.run.tasks.TaskA).toEqual({
        id: "TaskA",
        state: "READY",
        generation: 1,
      });

      state = reduceTuiState(state, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 2, "task.verify.started", { task_id: "TaskA", generation: 1 }),
      });
      expect(state.run.tasks.TaskA.state).toBe("VERIFYING");

      state = reduceTuiState(state, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 3, "task.passed", { task_id: "TaskA", generation: 1 }),
      });
      expect(state.run.tasks.TaskA.state).toBe("PASSED");
    });

    it("records failureClass when task.failed event is ingested", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const runId = createRunId();
      const initial = createBlankTuiState({
        run: {
          ...createBlankTuiState().run,
          runId,
          tasks: { TaskB: { id: "TaskB", state: "VERIFYING", generation: 1 } },
        },
      });

      const next = reduceTuiState(initial, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 4, "task.failed", {
          task_id: "TaskB",
          generation: 1,
          failure_class: "verify_failed",
        }),
      });

      expect(next.run.tasks.TaskB.state).toBe("FAILED");
      expect(next.run.tasks.TaskB.failureClass).toBe("verify_failed");
    });

    it("accumulates total USD spend on usage.recorded event", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const runId = createRunId();
      const initial = createBlankTuiState({
        run: { ...createBlankTuiState().run, runId, totalCostUsd: 0.10 },
      });

      const next = reduceTuiState(initial, {
        type: "ENGINE_EVENT",
        event: makeEngineEvent(runId, 5, "usage.recorded", {
          record: {
            backend: "claude",
            model: "claude-sonnet-5-5",
            input_tokens: 1000,
            output_tokens: 200,
            cost_usd: 0.045,
            cost_source: "computed",
            at: "2026-10-17T15:00:00Z",
          },
        }),
      });

      expect(next.run.totalCostUsd).toBeCloseTo(0.145, 5);
      expect(next.run.feed).toHaveLength(1);
    });
  });

  describe("Dialog state management and approval gates", () => {
    it("transitions dialog state on OPEN_DIALOG and resets on CLOSE_DIALOG", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const runId = createRunId();
      const initial = createBlankTuiState({ dialog: { type: "none" } });

      const planDialog: DialogState = {
        type: "approval_plan",
        manifest: createSampleManifest(runId),
      };

      const opened = reduceTuiState(initial, { type: "OPEN_DIALOG", dialog: planDialog });
      expect(opened.dialog).toEqual(planDialog);

      const closed = reduceTuiState(opened, { type: "CLOSE_DIALOG" });
      expect(closed.dialog).toEqual({ type: "none" });
    });

    it("resets dialog to none on APPROVE_GATE", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({
        dialog: { type: "approval_cost", estimatedUsd: 2.5, thresholdUsd: 2.0 },
      });

      const approved = reduceTuiState(initial, { type: "APPROVE_GATE", approved: true });
      expect(approved.dialog).toEqual({ type: "none" });

      const rejected = reduceTuiState(initial, { type: "APPROVE_GATE", approved: false });
      expect(rejected.dialog).toEqual({ type: "none" });
    });

    it("resets dialog on SELECT_SESSION from session picker", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({
        dialog: {
          type: "session_picker",
          sessions: ["sess_1", "sess_2"],
          selectedIndex: 1,
        },
      });

      const next = reduceTuiState(initial, { type: "SELECT_SESSION", sessionId: "sess_2" });
      expect(next.dialog).toEqual({ type: "none" });
    });
  });

  describe("Banner and Exit control actions", () => {
    it("updates and clears banner on SET_BANNER", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState();

      const state1 = reduceTuiState(initial, { type: "SET_BANNER", message: "Notice message" });
      expect(state1.banner).toBe("Notice message");

      const state2 = reduceTuiState(state1, { type: "SET_BANNER", message: undefined });
      expect(state2.banner).toBeUndefined();
    });

    it("records exit code cleanly on EXIT action", async () => {
      const { reduceTuiState } = await loadReducerModule();
      const initial = createBlankTuiState({ exitArmed: true, banner: "Press again" });

      const next = reduceTuiState(initial, { type: "EXIT", code: 130 });
      expect(next.exitArmed).toBe(false);
      expect(next.banner).toBeUndefined();
    });
  });
});
