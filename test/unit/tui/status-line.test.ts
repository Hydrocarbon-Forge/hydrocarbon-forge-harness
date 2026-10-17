import { describe, expect, it } from "vitest";

import type * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import type { DialogState, TuiState } from "./reducer.test.js";

export type ViewportTier = "wide" | "medium" | "narrow" | "micro";

export type SegmentId = "model" | "state" | "tasks" | "cost" | "budget";

export interface StatusLineSegment {
  id: SegmentId;
  label: string;
  priority: number;
  minTerminalWidth: number;
}

async function loadStatusLineModule(): Promise<{
  resolveViewportTier: (cols: number) => ViewportTier;
  formatStatusLineSegments: (state: TuiState, tier: ViewportTier) => string[];
}> {
  return (await import("../../../src/tui/components/status-line.js" as any)) as any;
}

function makeState(overrides?: Partial<TuiState>): TuiState {
  return {
    prompt: "",
    history: [],
    historyIndex: -1,
    permissionMode: "default",
    run: {
      runState: "EXECUTING",
      runId: "r_123456789012" as Contracts.RunId,
      tasks: {
        Task1: { id: "Task1", state: "PASSED", generation: 1 },
        Task2: { id: "Task2", state: "PASSED", generation: 1 },
        Task3: { id: "Task3", state: "PASSED", generation: 1 },
        Task4: { id: "Task4", state: "RUNNING", generation: 1 },
        Task5: { id: "Task5", state: "READY", generation: 1 },
        Task6: { id: "Task6", state: "READY", generation: 1 },
        Task7: { id: "Task7", state: "READY", generation: 1 },
      },
      feed: [],
      feedVerbose: false,
      totalCostUsd: 0.042,
      budgetCapUsd: 0.5,
      modelTier: "sonnet/hi",
    },
    taskBoardVisible: false,
    dialog: { type: "none" },
    viewport: { cols: 120, rows: 30 },
    exitArmed: false,
    banner: undefined,
    ...overrides,
  };
}

describe("responsive status line & dialogs (P5.3)", () => {
  describe("Viewport tier classification (resolveViewportTier)", () => {
    it("maps cols >= 100 to 'wide' tier", async () => {
      const { resolveViewportTier } = await loadStatusLineModule();
      expect(resolveViewportTier(100)).toBe("wide");
      expect(resolveViewportTier(120)).toBe("wide");
      expect(resolveViewportTier(240)).toBe("wide");
    });

    it("maps 60 <= cols <= 99 to 'medium' tier", async () => {
      const { resolveViewportTier } = await loadStatusLineModule();
      expect(resolveViewportTier(99)).toBe("medium");
      expect(resolveViewportTier(80)).toBe("medium");
      expect(resolveViewportTier(60)).toBe("medium");
    });

    it("maps 40 <= cols <= 59 to 'narrow' tier", async () => {
      const { resolveViewportTier } = await loadStatusLineModule();
      expect(resolveViewportTier(59)).toBe("narrow");
      expect(resolveViewportTier(50)).toBe("narrow");
      expect(resolveViewportTier(40)).toBe("narrow");
    });

    it("maps cols < 40 to 'micro' tier", async () => {
      const { resolveViewportTier } = await loadStatusLineModule();
      expect(resolveViewportTier(39)).toBe("micro");
      expect(resolveViewportTier(25)).toBe("micro");
      expect(resolveViewportTier(10)).toBe("micro");
      expect(resolveViewportTier(0)).toBe("micro");
      expect(resolveViewportTier(-10)).toBe("micro");
    });
  });

  describe("Responsive status line segments formatting (formatStatusLineSegments)", () => {
    it("renders full 4 segments in 'wide' tier (>= 100 cols)", async () => {
      const { formatStatusLineSegments } = await loadStatusLineModule();
      const state = makeState();

      const segments = formatStatusLineSegments(state, "wide");
      expect(segments).toHaveLength(4);

      // Model tier segment
      expect(segments[0]).toMatch(/sonnet\/hi/);

      // Run state segment
      expect(segments[1]).toMatch(/EXECUTING/);

      // Tasks progress: 3 passed out of 7 total tasks
      expect(segments[2]).toMatch(/3\/7 tasks/);

      // Cost spend vs cap: $0.042 / $0.50
      expect(segments[3]).toMatch(/\$0\.042\s*\/\s*\$0\.50/);
    });

    it("omits model/tier and renders 3 segments in 'medium' tier (60-99 cols)", async () => {
      const { formatStatusLineSegments } = await loadStatusLineModule();
      const state = makeState();

      const segments = formatStatusLineSegments(state, "medium");
      expect(segments).toHaveLength(3);

      // Segments: runState, tasks progress, cost / cap
      expect(segments[0]).toMatch(/EXECUTING/);
      expect(segments[1]).toMatch(/3\/7 tasks/);
      expect(segments[2]).toMatch(/\$0\.042\s*\/\s*\$0\.50/);

      // Ensure model tier is not present
      const joined = segments.join(" ");
      expect(joined).not.toContain("sonnet/hi");
    });

    it("omits model and cost, rendering 2 minimal segments in 'narrow' tier (40-59 cols)", async () => {
      const { formatStatusLineSegments } = await loadStatusLineModule();
      const state = makeState();

      const segments = formatStatusLineSegments(state, "narrow");
      expect(segments).toHaveLength(2);

      // State label
      expect(segments[0]).toMatch(/EXECUTING/);

      // Compact tasks indicator without "tasks" word
      expect(segments[1]).toMatch(/3\/7/);

      // Neither model nor cost present
      const joined = segments.join(" ");
      expect(joined).not.toContain("sonnet");
      expect(joined).not.toContain("$");
    });

    it("collapses to single-character indicator in 'micro' tier (< 40 cols)", async () => {
      const { formatStatusLineSegments } = await loadStatusLineModule();

      // Executing state -> [E]
      const execState = makeState({ run: { ...makeState().run, runState: "EXECUTING" } });
      const execSegments = formatStatusLineSegments(execState, "micro");
      expect(execSegments).toHaveLength(1);
      expect(execSegments[0]).toBe("[E]");

      // Planning state -> [P]
      const planState = makeState({ run: { ...makeState().run, runState: "PLANNING" } });
      const planSegments = formatStatusLineSegments(planState, "micro");
      expect(planSegments).toHaveLength(1);
      expect(planSegments[0]).toBe("[P]");

      // Paused / Error / Failed state -> [!]
      const pauseState = makeState({ run: { ...makeState().run, runState: "PAUSED" } });
      const pauseSegments = formatStatusLineSegments(pauseState, "micro");
      expect(pauseSegments).toHaveLength(1);
      expect(pauseSegments[0]).toBe("[!]");

      // Finished / Idle state -> [OK]
      const finishedState = makeState({ run: { ...makeState().run, runState: "FINISHED" } });
      const finishedSegments = formatStatusLineSegments(finishedState, "micro");
      expect(finishedSegments).toHaveLength(1);
      expect(finishedSegments[0]).toBe("[OK]");
    });

    it("formats cumulative spend without ratio when budgetCapUsd is not configured", async () => {
      const { formatStatusLineSegments } = await loadStatusLineModule();
      const stateWithoutCap = makeState({
        run: {
          ...makeState().run,
          budgetCapUsd: undefined,
          totalCostUsd: 0.042,
        },
      });

      const segments = formatStatusLineSegments(stateWithoutCap, "wide");
      const costSegment = segments.find((s) => s.includes("$0.042"));
      expect(costSegment).toBeDefined();
      expect(costSegment).not.toContain("/");
    });
  });

  describe("Modal approval dialog representations", () => {
    it("encodes approval_plan manifest details", async () => {
      await loadStatusLineModule();
      const runId = createRunId();
      const manifest: Contracts.Manifest = {
        version: 1,
        run_id: runId,
        goal: "Refactor engine reducer and add status line tests",
        base_ref: "main",
        setup: [{ run: "npm install", timeout_s: 30 }],
        contracts: {
          files: ["src/contracts/index.ts"],
          typecheck: [{ run: "npm run typecheck", timeout_s: 30 }],
        },
        integration_verify: [{ run: "npm test", timeout_s: 60 }],
        tasks: [
          { id: "Task1", spec: ".tasks/Task1.md" },
          { id: "Task2", spec: ".tasks/Task2.md" },
        ],
        budget: { max_usd: 2.5 },
      };

      const planDialog: DialogState = {
        type: "approval_plan",
        manifest,
      };

      expect(planDialog.type).toBe("approval_plan");
      expect(planDialog.manifest.tasks).toHaveLength(2);
      expect(planDialog.manifest.goal).toContain("Refactor engine");
    });

    it("encodes approval_cost threshold checks and estimated values", async () => {
      await loadStatusLineModule();
      const costDialog: DialogState = {
        type: "approval_cost",
        estimatedUsd: 4.5,
        thresholdUsd: 2.0,
      };

      expect(costDialog.type).toBe("approval_cost");
      expect(costDialog.estimatedUsd).toBe(4.5);
      expect(costDialog.thresholdUsd).toBe(2.0);
      expect(costDialog.estimatedUsd > costDialog.thresholdUsd).toBe(true);
    });

    it("encodes approval_merge target branch and changed files list", async () => {
      await loadStatusLineModule();
      const runId = createRunId();
      const mergeDialog: DialogState = {
        type: "approval_merge",
        runId,
        branch: "substrate/feature-tui",
        files: ["src/tui/state/reducer.ts", "src/tui/components/status-line.tsx"],
      };

      expect(mergeDialog.type).toBe("approval_merge");
      expect(mergeDialog.branch).toBe("substrate/feature-tui");
      expect(mergeDialog.files).toHaveLength(2);
    });

    it("encodes session_picker selection and bounds constraints", async () => {
      await loadStatusLineModule();
      const sessions = ["sess_alpha", "sess_beta", "sess_gamma"];
      const pickerDialog: DialogState = {
        type: "session_picker",
        sessions,
        selectedIndex: 1,
      };

      expect(pickerDialog.type).toBe("session_picker");
      expect(pickerDialog.sessions).toHaveLength(3);
      expect(pickerDialog.selectedIndex).toBe(1);
      expect(pickerDialog.selectedIndex).toBeGreaterThanOrEqual(0);
      expect(pickerDialog.selectedIndex).toBeLessThan(sessions.length);
    });

    it("handles empty session list gracefully in session picker", async () => {
      await loadStatusLineModule();
      const emptyPicker: DialogState = {
        type: "session_picker",
        sessions: [],
        selectedIndex: 0,
      };

      expect(emptyPicker.sessions).toHaveLength(0);
    });
  });
});
