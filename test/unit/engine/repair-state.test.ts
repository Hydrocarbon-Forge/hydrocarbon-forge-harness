import { describe, expect, it } from "vitest";

import { parseEngineEvent } from "../../../src/contracts/events.js";
import { repairOf, repairedOf } from "../../../src/engine/landing.js";
import { reduce, type EngineState } from "../../../src/engine/reducer.js";

// R12.4: the repair events parse against the catalog, the repair rows stay apart from the plan's tasks,
// and the summary's repair facts read the last round of attempts.

const ev = (seq: number, type: string, data: unknown) =>
  ({ v: 1, seq, ts: "2026-10-21T00:00:00.000Z", run_id: "r_TEST", type, data }) as const;

const integrating = (): EngineState => ({
  run_id: "r_TEST",
  state: "INTEGRATING",
  tasks: {
    T1: { id: "T1", state: "MERGED", generation: 1, attempt: 1 },
  },
  usage: { total_usd: 0, by_role: {} },
  checkpoints: [],
});

describe("repair events (R12.4)", () => {
  it("parse against the catalog", () => {
    expect(() => parseEngineEvent(ev(1, "integration.repair.started", { task_id: "REPAIR-1", attempt: 1, max: 2 }))).not.toThrow();
    expect(() =>
      parseEngineEvent(ev(2, "integration.repair.finished", { task_id: "REPAIR-1", attempt: 1, passed: false, reason: "x" })),
    ).not.toThrow();
    expect(() => parseEngineEvent(ev(3, "integration.finished", { passed: true, repaired: 2 }))).not.toThrow();
  });

  it("reject a bad attempt, an unknown key, and a repaired count above 5", () => {
    expect(() => parseEngineEvent(ev(1, "integration.repair.started", { task_id: "REPAIR-1", attempt: 0, max: 2 }))).toThrow();
    expect(() => parseEngineEvent(ev(1, "integration.repair.started", { task_id: "REPAIR-1", attempt: 1, max: 2, x: 1 }))).toThrow();
    expect(() => parseEngineEvent(ev(1, "integration.finished", { passed: true, repaired: 6 }))).toThrow();
  });
});

describe("the reducer keeps repair attempts apart from the plan's tasks (R12.4)", () => {
  it("a started attempt is a RUNNING row in repairs, and the tasks and the run state do not change", () => {
    const before = integrating();
    const after = reduce(before, ev(2, "integration.repair.started", { task_id: "REPAIR-1", attempt: 1, max: 2 }));
    expect(after.repairs?.["REPAIR-1"]).toMatchObject({ id: "REPAIR-1", state: "RUNNING" });
    expect(after.tasks).toEqual(before.tasks);
    expect(after.state).toBe("INTEGRATING");
  });

  it("a rejected attempt is FAILED and a passed one is MERGED; neither changes the run state", () => {
    let state = integrating();
    state = reduce(state, ev(2, "integration.repair.started", { task_id: "REPAIR-1", attempt: 1, max: 2 }));
    state = reduce(state, ev(3, "integration.repair.finished", { task_id: "REPAIR-1", attempt: 1, passed: false, reason: "no" }));
    expect(state.repairs?.["REPAIR-1"]).toMatchObject({ state: "FAILED", failure_message: "no" });
    state = reduce(state, ev(4, "integration.repair.started", { task_id: "REPAIR-2", attempt: 2, max: 2 }));
    state = reduce(state, ev(5, "integration.repair.finished", { task_id: "REPAIR-2", attempt: 2, passed: true }));
    expect(state.repairs?.["REPAIR-2"]).toMatchObject({ state: "MERGED" });
    expect(state.state).toBe("INTEGRATING");
    expect(Object.keys(state.tasks)).toEqual(["T1"]);
  });
});

describe("repairOf and repairedOf read the summary's facts (R12.4)", () => {
  it("are undefined when no repair ran", () => {
    expect(repairOf([ev(1, "integration.started", {})])).toBeUndefined();
    expect(repairedOf([ev(1, "integration.finished", { passed: true })])).toBeUndefined();
  });

  it("list each attempt of the last round, and say whether one passed", () => {
    const events = [
      ev(1, "integration.repair.started", { task_id: "REPAIR-1", attempt: 1, max: 2 }),
      ev(2, "integration.repair.finished", { task_id: "REPAIR-1", attempt: 1, passed: false, reason: "it deletes test file t.test.ts" }),
      ev(3, "integration.repair.started", { task_id: "REPAIR-2", attempt: 2, max: 2 }),
      ev(4, "integration.repair.finished", { task_id: "REPAIR-2", attempt: 2, passed: true }),
    ];
    expect(repairOf(events)).toEqual({
      attempts: 2,
      passed: true,
      outcomes: ["attempt 1: rejected: it deletes test file t.test.ts", "attempt 2: passed"],
    });
    expect(repairedOf([...events, ev(5, "integration.finished", { passed: true, repaired: 2 })])).toBe(2);
  });

  it("report the last reason when no attempt passed, and only the latest round", () => {
    const events = [
      ev(1, "integration.repair.started", { task_id: "REPAIR-1", attempt: 1, max: 1 }),
      ev(2, "integration.repair.finished", { task_id: "REPAIR-1", attempt: 1, passed: false, reason: "old round" }),
      ev(3, "integration.repair.started", { task_id: "REPAIR-1", attempt: 1, max: 1 }),
      ev(4, "integration.repair.finished", { task_id: "REPAIR-1", attempt: 1, passed: false, reason: "CHECK-UNFIXABLE: no tool" }),
    ];
    expect(repairOf(events)).toEqual({
      attempts: 1,
      passed: false,
      reason: "CHECK-UNFIXABLE: no tool",
      outcomes: ["attempt 1: rejected: CHECK-UNFIXABLE: no tool"],
    });
  });
});
