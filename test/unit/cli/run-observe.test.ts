import { describe, expect, it } from "vitest";

import type { EngineEvent } from "../../../src/contracts/index.js";
import { countsOf, statusOf, taskRowsOf, type RunRecord } from "../../../src/observe/run-observe.js";
import { reduce, type EngineState } from "../../../src/engine/reducer.js";
import { applyJournalEvent } from "../../../src/engine/journal.js";

// R10.2: the status a run shows, and its task rows, as `status`, `watch` and `runs` read them.

const RUN = "r_TESTRUN00002";

function stateWith(state: EngineState["state"], pause_reason?: EngineState["pause_reason"]): EngineState {
  return {
    run_id: RUN as EngineState["run_id"],
    state,
    ...(pause_reason ? { pause_reason } : {}),
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
}

describe("R10.2: a run's status word", () => {
  it("names a terminal state itself, and a non-terminal state is running only with a live process", () => {
    expect(statusOf(stateWith("FINISHED"), false)).toBe("finished");
    expect(statusOf(stateWith("FAILED"), true)).toBe("failed");
    expect(statusOf(stateWith("PAUSED", "user_cancel"), false)).toBe("interrupted");
    expect(statusOf(stateWith("PAUSED", "budget_exhausted"), false)).toBe("paused");
    expect(statusOf(stateWith("EXECUTING"), true)).toBe("running");
    expect(statusOf(stateWith("EXECUTING"), false)).toBe("stopped");
  });

  it("the journal's reduction and the plain reducer end a run at the state its run.finished names (R10.5)", () => {
    const finished: EngineEvent = {
      v: 1,
      seq: 2,
      ts: "2026-10-21T10:00:00.000Z",
      run_id: RUN,
      type: "run.finished",
      data: { exit_code: 1, status: "failed" },
    } as EngineEvent;
    const before = stateWith("EXECUTING");
    // R10.5: the reducer owns the terminal state, so a replay of the log equals the live journal.
    expect(reduce(before, finished).state).toBe("FAILED");
    expect(applyJournalEvent(before, finished).state).toBe("FAILED");
  });
});

describe("R10.2: the task rows of a run", () => {
  it("names each planned task's display state, its cost and merge, and counts them", () => {
    const events: EngineEvent[] = [
      {
        v: 1,
        seq: 1,
        ts: "2026-10-21T10:00:00.000Z",
        run_id: RUN,
        type: "plan.produced",
        data: {
          tasks: [
            { id: "T1", title: "Rules", class: "logic" },
            { id: "T2", title: "UI", depends_on: ["T1"] },
            { id: "T3", title: "Docs" },
          ],
        },
      } as EngineEvent,
      {
        v: 1,
        seq: 2,
        ts: "2026-10-21T10:00:01.000Z",
        run_id: RUN,
        type: "usage.recorded",
        data: { task_id: "T1", record: { cost_usd: 0.25 } },
      } as EngineEvent,
      {
        v: 1,
        seq: 3,
        ts: "2026-10-21T10:00:02.000Z",
        run_id: RUN,
        type: "task.merged",
        data: { task_id: "T1" },
      } as EngineEvent,
    ];
    const state: EngineState = {
      ...stateWith("EXECUTING"),
      tasks: {
        T1: { id: "T1", state: "MERGED", generation: 1, attempt: 1 },
        T2: { id: "T2", state: "PENDING", generation: 1, attempt: 1 },
      } as unknown as EngineState["tasks"],
    };
    const record: RunRecord = {
      runId: RUN,
      runDir: "/unused",
      events,
      state,
      createdAt: undefined,
      lastEventAt: undefined,
      process: { pid: 1, alive: true },
      terminal: false,
      status: "running",
    };
    const rows = taskRowsOf(record);
    expect(rows.map((r) => [r.id, r.state, r.merged])).toEqual([
      ["T1", "passed", true],
      ["T2", "waiting", false],
      ["T3", "waiting", false],
    ]);
    expect(rows[0]).toMatchObject({ title: "Rules", class: "logic", cost_usd: 0.25 });
    expect(rows[1].depends_on).toEqual(["T1"]);
    expect(countsOf(rows)).toEqual({ passed: 1, running: 0, failed: 0, waiting: 2, skipped: 0 });
  });
});
