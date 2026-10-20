import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import { evaluateEscalation, type EscalationAction } from "../../../src/engine/ladder.js";
import { type EngineState } from "../../../src/engine/reducer.js";

function makeSettings(): Contracts.Settings {
  return Contracts.Settings.parse({
    backends: {},
    roles: {
      planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    },
    routing: {
      feature: { backend: "claude", model: "claude-haiku-5-5", effort: "low" },
      escalation: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    },
    pricing: {
      asOf: "2026-10-16",
      sources: ["https://example.com"],
      models: {},
    },
    budgets: {
      run: { max_usd: 10 },
      task: { max_usd: 1.0 },
      l1_replans_per_task: 2,
      l2_per_run: 2,
      planner_format_retries: 2,
      approval_threshold_usd: 2,
    },
    concurrency: { workers: 3 },
    permissions: { allow: [], deny: [] },
    sandbox: { enabled: true },
    git: { on_scope_violation: "revert", auto_merge: false },
    instructions: { workers: "none" },
    execution: { strategy: "direct" },
  });
}

function makeState(taskState: Partial<Contracts.TaskRuntimeState> = {}): EngineState {
  const runId = createRunId();
  return {
    run_id: runId,
    state: "EXECUTING",
    tasks: {
      TaskA: {
        id: "TaskA",
        state: "VERIFYING",
        generation: 1,
        attempt: 1,
        session_id: "sess_orig_123",
        ...taskState,
      },
    },
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
}

describe("engine: escalation ladder L0 healing", () => {
  it("returns L0 heal action on first verify failure in current generation", () => {
    const settings = makeSettings();
    const state = makeState({ generation: 1, attempt: 1, session_id: "sess_test_1" });

    const action = evaluateEscalation(state, "TaskA", "verify_failed", settings);

    expect(action).toEqual({
      level: "L0",
      action: "heal",
      session_id: "sess_test_1",
    });
  });

  it("enforces L0 cap: attempt 2 cannot heal, escalates to L1 replan", () => {
    const settings = makeSettings();
    const state = makeState({ generation: 1, attempt: 2, session_id: "sess_test_1" });

    const action = evaluateEscalation(state, "TaskA", "verify_failed", settings);

    expect(action.level).toBe("L1");
    if (action.level === "L1") {
      expect(action.action).toBe("replan");
      expect(action.generation).toBe(2);
      expect(action.route.model).toBe("claude-sonnet-5-5"); // Next tier up from haiku
    }
  });
});

describe("engine: escalation ladder L1 replanning and tier escalation", () => {
  it("escalates immediately to L1 replan on scope violation, protected modification, or merge conflict", () => {
    const settings = makeSettings();

    for (const failure of ["scope_violation", "protected_modified", "merge_conflict", "budget_exceeded"] as Contracts.FailureClass[]) {
      const state = makeState({ generation: 1, attempt: 1 });
      const action = evaluateEscalation(state, "TaskA", failure, settings);

      expect(action.level).toBe("L1");
      if (action.level === "L1") {
        expect(action.action).toBe("replan");
        expect(action.generation).toBe(2);
      }
    }
  });

  it("escalates model tier: haiku -> sonnet -> opus", () => {
    const settings = makeSettings();

    // Generation 1 -> Replan to Gen 2 (Sonnet)
    const stateGen1 = makeState({ generation: 1, attempt: 2 });
    const actionGen1 = evaluateEscalation(stateGen1, "TaskA", "verify_failed", settings);
    expect(actionGen1.level).toBe("L1");
    if (actionGen1.level === "L1") {
      expect(actionGen1.route.model).toBe("claude-sonnet-5-5");
      expect(actionGen1.generation).toBe(2);
    }

    // Generation 2 -> Replan to Gen 3 (Opus)
    const stateGen2 = makeState({ generation: 2, attempt: 2 });
    const actionGen2 = evaluateEscalation(stateGen2, "TaskA", "verify_failed", settings);
    expect(actionGen2.level).toBe("L1");
    if (actionGen2.level === "L1") {
      expect(actionGen2.route.model).toBe("claude-opus-5-5");
      expect(actionGen2.generation).toBe(3);
    }
  });

  it("enforces L1 replan cap (default 2 replans, max generation 3)", () => {
    const settings = makeSettings();
    // At generation 3, 2 replans have already occurred; cannot replan further
    const stateGen3 = makeState({ generation: 3, attempt: 2 });

    const action = evaluateEscalation(stateGen3, "TaskA", "verify_failed", settings);
    // Escalates beyond L1 to L2 or L3
    expect(["L2", "L3"]).toContain(action.level);
  });
});

describe("engine: escalation ladder L2 contract defects and L3 human pause", () => {
  it("escalates to L2 contract defect when L1 replans exhausted and L2 budget remains", () => {
    const settings = makeSettings();
    const state = makeState({ generation: 3, attempt: 2 });

    const action = evaluateEscalation(state, "TaskA", "verify_failed", settings);
    expect(action).toEqual({
      level: "L2",
      action: "contract_defect",
    });
  });

  it("escalates to L3 pause with needs_human when L2 budget is also exhausted", () => {
    const settings = makeSettings();
    settings.budgets.l2_per_run = 0; // Exhausted L2
    const state = makeState({ generation: 3, attempt: 2 });

    const action = evaluateEscalation(state, "TaskA", "verify_failed", settings);
    expect(action).toEqual({
      level: "L3",
      action: "pause",
      reason: "needs_human",
    });
  });
});

describe("engine: escalation ladder non-replannable failures", () => {
  it("immediately pauses with permission_denied: NEVER replans or heals", () => {
    const settings = makeSettings();
    const state = makeState({ generation: 1, attempt: 1 });

    const action = evaluateEscalation(state, "TaskA", "permission_denied", settings);
    expect(action).toEqual({
      level: "L3",
      action: "pause",
      reason: "permission_denied",
    });
  });

  it("handles rate_limited: never replans, returns L3 pause with rate_limited when backoff exhausted", () => {
    const settings = makeSettings();
    const state = makeState({ generation: 1, attempt: 1 });

    const action = evaluateEscalation(state, "TaskA", "rate_limited", settings);
    expect(action.level).toBe("L3");
    if (action.level === "L3") {
      expect(action.action).toBe("pause");
      expect(action.reason).toBe("rate_limited");
    }
  });
});
