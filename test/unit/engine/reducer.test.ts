import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import {
  computeDagLayers,
  reduce,
  type EngineState,
  type RunState,
  type TaskState,
} from "../../../src/engine/reducer.js";

function makeEvent(
  run_id: Contracts.RunId,
  seq: number,
  type: string,
  data: unknown,
): Contracts.EngineEvent {
  return Contracts.EngineEvent.parse({
    v: 1,
    seq,
    ts: nowIsoTimestamp(),
    run_id,
    type,
    data,
  });
}

function createBlankState(run_id = createRunId()): EngineState {
  return {
    run_id,
    state: "CREATED",
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
}

describe("engine: reducer purity and state immutability", () => {
  it("never mutates the input state object or nested records", () => {
    const runId = createRunId();
    const initial = createBlankState(runId);
    initial.tasks["TaskA"] = {
      id: "TaskA",
      state: "READY",
      generation: 1,
      attempt: 1,
    };
    Object.freeze(initial);
    Object.freeze(initial.tasks);
    Object.freeze(initial.usage);
    Object.freeze(initial.checkpoints);

    const event = makeEvent(runId, 1, "task.session.started", {
      task_id: "TaskA",
      session_id: "sess_123",
    });

    const next = reduce(initial, event);
    expect(next).not.toBe(initial);
    expect(next.tasks["TaskA"]).not.toBe(initial.tasks["TaskA"]);
    expect(next.tasks["TaskA"].state).toBe("RUNNING");
    expect(initial.tasks["TaskA"].state).toBe("READY");
  });
});

describe("engine: reducer run lifecycle transitions", () => {
  it("initializes run on run.created event", () => {
    const runId = createRunId();
    const event = makeEvent(runId, 1, "run.created", { run_id: runId });

    const state = reduce(createBlankState(runId), event);
    expect(state.run_id).toBe(runId);
    expect(state.state).toBe("CREATED");
    expect(state.usage.total_usd).toBe(0);
    expect(state.usage.by_role).toEqual({});
    expect(state.tasks).toEqual({});
    expect(state.checkpoints).toEqual([]);
  });

  it("progresses run states: CREATED -> ROUTING/PLANNING -> LINTING -> AWAITING_APPROVAL -> SETUP -> EXECUTING", () => {
    const runId = createRunId();
    let state = createBlankState(runId);

    // run.routed transitions to ROUTING / PLANNING
    state = reduce(state, makeEvent(runId, 1, "run.routed", { mode: "plan" }));
    expect(["ROUTING", "PLANNING"]).toContain(state.state);

    // plan.produced transitions PLANNING -> LINTING
    state = reduce(state, makeEvent(runId, 2, "plan.produced", { manifest: { run_id: runId } }));
    expect(state.state).toBe("LINTING");

    // LINTING -> AWAITING_APPROVAL (when lint passes and approval is needed)
    state = reduce(state, makeEvent(runId, 3, "plan.lint", { ok: true, requires_approval: true }));
    expect(state.state).toBe("AWAITING_APPROVAL");

    // plan.approved transitions to SETUP
    state = reduce(state, makeEvent(runId, 4, "plan.approved", {}));
    expect(state.state).toBe("SETUP");

    // setup.done transitions to EXECUTING
    state = reduce(state, makeEvent(runId, 5, "setup.done", {}));
    expect(state.state).toBe("EXECUTING");
  });

  it("transitions to CANCELLED when plan is rejected", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.state = "AWAITING_APPROVAL";

    state = reduce(state, makeEvent(runId, 1, "plan.rejected", { reason: "User declined" }));
    expect(state.state).toBe("CANCELLED");
  });

  it("transitions EXECUTING -> INTEGRATING when all batch tasks are MERGED", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.state = "EXECUTING";
    state.tasks = {
      TaskA: { id: "TaskA", state: "MERGING", generation: 1, attempt: 1 },
      TaskB: { id: "TaskB", state: "MERGED", generation: 1, attempt: 1 },
    };

    // TaskA becomes merged
    state = reduce(state, makeEvent(runId, 1, "task.merged", { task_id: "TaskA" }));
    expect(state.tasks["TaskA"].state).toBe("MERGED");
    expect(state.state).toBe("INTEGRATING");
  });

  it("transitions INTEGRATING -> FINISHED when integration verification succeeds", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.state = "INTEGRATING";

    state = reduce(state, makeEvent(runId, 1, "integration.finished", { passed: true }));
    expect(state.state).toBe("FINISHED");
  });

  it("transitions to FAILED when integration verification fails", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.state = "INTEGRATING";

    state = reduce(state, makeEvent(runId, 1, "integration.finished", {
      passed: false,
      failure_class: "integration_failed",
    }));
    expect(state.state).toBe("FAILED");
  });

  it("pauses and resumes run with PauseReason preservation and state restoration", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.state = "EXECUTING";

    state = reduce(state, makeEvent(runId, 1, "run.paused", { reason: "rate_limited" }));
    expect(state.state).toBe("PAUSED");
    expect(state.pause_reason).toBe("rate_limited");

    state = reduce(state, makeEvent(runId, 2, "run.resumed", {}));
    expect(state.state).toBe("EXECUTING");
    expect(state.pause_reason).toBeUndefined();
  });
});

describe("engine: reducer task lifecycle transitions", () => {
  it("transitions task through happy path: PENDING -> READY -> RUNNING -> SCOPE_CHECK -> VERIFYING -> PASSED -> MERGING -> MERGED", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.state = "EXECUTING";

    // task.ready
    state = reduce(state, makeEvent(runId, 1, "task.ready", { task_id: "TaskA" }));
    expect(state.tasks["TaskA"]).toMatchObject({
      id: "TaskA",
      state: "READY",
      generation: 1,
      attempt: 1,
    });

    // task.session.started
    state = reduce(state, makeEvent(runId, 2, "task.session.started", {
      task_id: "TaskA",
      session_id: "sess_xyz",
    }));
    expect(state.tasks["TaskA"].state).toBe("RUNNING");
    expect(state.tasks["TaskA"].session_id).toBe("sess_xyz");

    // task.scope.checked
    state = reduce(state, makeEvent(runId, 3, "task.scope.checked", { task_id: "TaskA", ok: true }));
    expect(state.tasks["TaskA"].state).toBe("SCOPE_CHECK");

    // task.verify.started
    state = reduce(state, makeEvent(runId, 4, "task.verify.started", { task_id: "TaskA" }));
    expect(state.tasks["TaskA"].state).toBe("VERIFYING");

    // task.verify.finished (pass)
    state = reduce(state, makeEvent(runId, 5, "task.verify.finished", { task_id: "TaskA", passed: true }));
    expect(state.tasks["TaskA"].state).toBe("PASSED");

    // task.passed -> MERGING
    state = reduce(state, makeEvent(runId, 6, "task.passed", { task_id: "TaskA" }));
    expect(state.tasks["TaskA"].state).toBe("MERGING");

    // task.merged -> MERGED
    state = reduce(state, makeEvent(runId, 7, "task.merged", { task_id: "TaskA" }));
    expect(state.tasks["TaskA"].state).toBe("MERGED");
  });

  it("handles first verify failure in current generation: transitions to HEALING", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.tasks["TaskA"] = {
      id: "TaskA",
      state: "VERIFYING",
      generation: 1,
      attempt: 1,
    };

    state = reduce(state, makeEvent(runId, 1, "task.verify.finished", {
      task_id: "TaskA",
      passed: false,
      failure_class: "verify_failed",
    }));
    expect(state.tasks["TaskA"].state).toBe("HEALING");

    // task.healing increments attempt
    state = reduce(state, makeEvent(runId, 2, "task.healing", { task_id: "TaskA" }));
    expect(state.tasks["TaskA"].attempt).toBe(2);
    expect(state.tasks["TaskA"].state).toBe("HEALING");
  });

  it("handles second verify failure in current generation: transitions to FAILED", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.tasks["TaskA"] = {
      id: "TaskA",
      state: "VERIFYING",
      generation: 1,
      attempt: 2, // Second attempt
    };

    state = reduce(state, makeEvent(runId, 1, "task.verify.finished", {
      task_id: "TaskA",
      passed: false,
      failure_class: "verify_failed",
    }));
    expect(state.tasks["TaskA"].state).toBe("FAILED");
    expect(state.tasks["TaskA"].failure_class).toBe("verify_failed");
  });

  it("transitions FAILED task to REPLANNING and readies generation g + 1 if replans remain", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.tasks["TaskA"] = {
      id: "TaskA",
      state: "FAILED",
      generation: 1,
      attempt: 2,
    };

    state = reduce(state, makeEvent(runId, 1, "task.failed", {
      task_id: "TaskA",
      can_replan: true,
      max_replans: 2,
    }));
    expect(state.tasks["TaskA"].state).toBe("REPLANNING");

    // Replan finishes and readies g+1
    state = reduce(state, makeEvent(runId, 2, "replan.finished", {
      task_id: "TaskA",
      generation: 2,
    }));
    expect(state.tasks["TaskA"].generation).toBe(2);
    expect(state.tasks["TaskA"].attempt).toBe(1);
    expect(state.tasks["TaskA"].state).toBe("READY");
  });

  it("transitions task to BLOCKED when max replans are exhausted", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.tasks["TaskA"] = {
      id: "TaskA",
      state: "FAILED",
      generation: 3, // Max replans reached
      attempt: 2,
    };

    state = reduce(state, makeEvent(runId, 1, "task.failed", {
      task_id: "TaskA",
      can_replan: false,
      max_replans: 2,
    }));
    expect(state.tasks["TaskA"].state).toBe("BLOCKED");
  });

  it("cascades BLOCKED state to all dependent tasks in depends_on closure", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.tasks = {
      TaskA: { id: "TaskA", state: "RUNNING", generation: 1, attempt: 1 },
      TaskB: { id: "TaskB", state: "PENDING", generation: 1, attempt: 1 },
      TaskC: { id: "TaskC", state: "PENDING", generation: 1, attempt: 1 },
      TaskD: { id: "TaskD", state: "READY", generation: 1, attempt: 1 }, // Unrelated
    };

    // TaskB depends on TaskA; TaskC depends on TaskB
    const event = makeEvent(runId, 1, "task.blocked", {
      task_id: "TaskA",
      dependents: ["TaskB", "TaskC"],
    });

    state = reduce(state, event);
    expect(state.tasks["TaskA"].state).toBe("BLOCKED");
    expect(state.tasks["TaskB"].state).toBe("BLOCKED");
    expect(state.tasks["TaskC"].state).toBe("BLOCKED");
    expect(state.tasks["TaskD"].state).toBe("READY");
  });
});

describe("engine: reducer usage and budget enforcement", () => {
  it("accumulates cost into total_usd and role breakdown in usage.by_role", () => {
    const runId = createRunId();
    let state = createBlankState(runId);

    const usageRecord1 = {
      backend: "claude" as const,
      model: "claude-sonnet-5-5",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.25,
      cost_source: "reported" as const,
      at: nowIsoTimestamp(),
    };

    state = reduce(state, makeEvent(runId, 1, "usage.recorded", {
      role: "worker",
      task_id: "TaskA",
      record: usageRecord1,
    }));

    expect(state.usage.total_usd).toBeCloseTo(0.25, 4);
    expect(state.usage.by_role["worker"]).toBeCloseTo(0.25, 4);

    const usageRecord2 = {
      backend: "claude" as const,
      model: "claude-opus-5-5",
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 1.50,
      cost_source: "computed" as const,
      at: nowIsoTimestamp(),
    };

    state = reduce(state, makeEvent(runId, 2, "usage.recorded", {
      role: "planner",
      record: usageRecord2,
    }));

    expect(state.usage.total_usd).toBeCloseTo(1.75, 4);
    expect(state.usage.by_role["worker"]).toBeCloseTo(0.25, 4);
    expect(state.usage.by_role["planner"]).toBeCloseTo(1.50, 4);
  });

  it("does not transition run to PAUSED on usage.recorded (actions handle budget pauses)", () => {
    const runId = createRunId();
    let state = createBlankState(runId);
    state.state = "EXECUTING";

    state = reduce(state, makeEvent(runId, 1, "usage.recorded", {
      role: "worker",
      record: {
        backend: "claude",
        model: "claude-opus-5-5",
        input_tokens: 50000,
        output_tokens: 10000,
        cost_usd: 5.25,
        cost_source: "reported",
        at: nowIsoTimestamp(),
      },
    }));

    expect(state.state).toBe("EXECUTING");
    expect(state.pause_reason).toBeUndefined();
  });
});

describe("engine: computeDagLayers topological sorting", () => {
  it("computes layers for independent tasks: single layer", () => {
    const tasks = [
      { id: "A", depends_on: [] },
      { id: "B", depends_on: [] },
      { id: "C", depends_on: [] },
    ];
    const layers = computeDagLayers(tasks);
    expect(layers).toHaveLength(1);
    expect(layers[0].sort()).toEqual(["A", "B", "C"]);
  });

  it("computes layers for linear dependency chain A -> B -> C", () => {
    const tasks = [
      { id: "C", depends_on: ["B"] },
      { id: "B", depends_on: ["A"] },
      { id: "A", depends_on: [] },
    ];
    const layers = computeDagLayers(tasks);
    expect(layers).toEqual([["A"], ["B"], ["C"]]);
  });

  it("computes layers for diamond dependencies A -> (B, C) -> D", () => {
    const tasks = [
      { id: "A", depends_on: [] },
      { id: "B", depends_on: ["A"] },
      { id: "C", depends_on: ["A"] },
      { id: "D", depends_on: ["B", "C"] },
    ];
    const layers = computeDagLayers(tasks);
    expect(layers).toHaveLength(3);
    expect(layers[0]).toEqual(["A"]);
    expect(layers[1].sort()).toEqual(["B", "C"]);
    expect(layers[2]).toEqual(["D"]);
  });

  it("throws cycle error on circular dependency A -> B -> A", () => {
    const tasks = [
      { id: "A", depends_on: ["B"] },
      { id: "B", depends_on: ["A"] },
    ];
    expect(() => computeDagLayers(tasks)).toThrow(/cycle/i);
  });

  it("throws cycle error on self-dependency A -> A", () => {
    const tasks = [{ id: "A", depends_on: ["A"] }];
    expect(() => computeDagLayers(tasks)).toThrow(/cycle/i);
  });
});
