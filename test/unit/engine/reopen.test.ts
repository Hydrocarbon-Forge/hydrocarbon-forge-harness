import { describe, it, expect } from "vitest";

import { reduce, type EngineState } from "../../../src/engine/reducer.js";
import { endedFailed, reopenData } from "../../../src/engine/engine.js";
import type { EngineEvent } from "../../../src/contracts/index.js";

// R10.4: a run that ended failed is reopened. The reducer is the one place the states change, so a
// replay of the log must give the same state every time, and the reopened tasks get a fresh replan ladder.

const RUN = "r_REOPENTEST000";
let seq = 0;
function ev(type: string, data: Record<string, unknown> = {}): EngineEvent {
  seq += 1;
  return { v: 1, seq, ts: "2026-10-21T00:00:00.000Z", run_id: RUN, type, data } as unknown as EngineEvent;
}

/** A plan of T1 (merged), T2 (blocked after its replans ran out) and T3 (skipped because T2 is blocked). */
function failedLog(): EngineEvent[] {
  seq = 0;
  return [
    ev("run.created", { run_id: RUN, merge: true, concurrency: 1 }),
    ev("run.routed", { mode: "plan" }),
    ev("plan.produced", { tasks: [{ id: "T1" }, { id: "T2" }, { id: "T3" }] }),
    ev("plan.lint", { requires_approval: false }),
    ev("setup.done", {
      tasks: [
        { id: "T1", depends_on: [], write: ["a"], create: [] },
        { id: "T2", depends_on: [], write: ["b"], create: [] },
        { id: "T3", depends_on: ["T2"], write: ["c"], create: [] },
      ],
    }),
    ev("task.ready", { task_id: "T1" }),
    ev("task.ready", { task_id: "T2" }),
    ev("task.merged", { task_id: "T1" }),
    ev("task.failed", { task_id: "T2", can_replan: false, failure_class: "verify_failed", message: "boom" }),
    ev("task.skipped", { task_id: "T3", reason: "dependency_failed", failed: ["T2"], skipped: [] }),
    ev("run.finished", { exit_code: 1, status: "failed", reason: "tasks_failed", failed_tasks: ["T2"] }),
  ];
}

function replay(events: EngineEvent[]): EngineState {
  let state: EngineState = { run_id: RUN as never, state: "CREATED", tasks: {}, usage: { total_usd: 0, by_role: {} }, checkpoints: [] };
  for (const e of events) state = reduce(state, e);
  return state;
}

describe("R10.4: a reopened run's state is the replay of its log", () => {
  it("a failed run is detected from its last run.finished, and a reopen after it closes the failure", () => {
    const log = failedLog();
    expect(endedFailed(log)).toBe(true);
    expect(endedFailed([...log, ev("run.reopened", { reason: "tasks" })])).toBe(false);
  });

  it("the reopen data names the failed task, the skipped dependent and the kept merge", () => {
    const log = failedLog();
    const data = reopenData(log, replay(log));
    expect(data).toEqual({ reason: "tasks", failed_tasks: ["T2"], skipped_tasks: ["T3"], kept_tasks: ["T1"] });
  });

  it("replaying the reopened log twice gives the same state; T1 stays merged; T2 and T3 are pending again", () => {
    const log = failedLog();
    const reopen = ev("run.reopened", reopenData(log, replay(log)));
    const full = [...log, reopen];
    const first = replay(full);
    const second = replay(full);
    expect(second).toEqual(first);
    expect(first.state).toBe("EXECUTING");
    expect(first.pause_reason).toBeUndefined();
    expect(first.tasks.T1.state).toBe("MERGED");
    expect(first.tasks.T2).toMatchObject({ state: "PENDING", generation: 2, attempt: 1, ladder_base: 2 });
    expect(first.tasks.T2.failure_class).toBeUndefined();
    expect(first.tasks.T3.state).toBe("PENDING");
  });

  it("the reopened task has a fresh replan ladder: its first failure replans even when its old generation was past the limit", () => {
    const log = failedLog();
    const reopen = ev("run.reopened", reopenData(log, replay(log)));
    const state = reduce(replay([...log, reopen]), ev("task.failed", { task_id: "T2", failure_class: "verify_failed" }));
    expect(state.tasks.T2.state).toBe("REPLANNING");
  });

  it("a planning failure reopens to CREATED with no tasks, so routing plans again", () => {
    seq = 0;
    const log = [ev("run.created", { run_id: RUN }), ev("run.routed", { mode: "plan" }), ev("run.finished", { exit_code: 1, status: "failed" })];
    expect(endedFailed(log)).toBe(true);
    expect(reopenData(log, replay(log))).toEqual({ reason: "planning" });
    const reopened = replay([...log, ev("run.reopened", { reason: "planning" })]);
    expect(reopened.state).toBe("CREATED");
    expect(reopened.tasks).toEqual({});
  });
});
