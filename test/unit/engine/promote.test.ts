import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import {
  blockedPendingTasks,
  promoteReadyTasks,
  scheduleNextTasks,
} from "../../../src/engine/scheduler.js";
import { type EngineState, type TaskRuntimeState } from "../../../src/engine/reducer.js";

function makeSettings(
  workers = 3,
  maxUsd = 10,
  backendCap?: number
): Contracts.Settings {
  return Contracts.Settings.parse({
    backends: backendCap === undefined ? {} : { claude: { max_concurrency: backendCap } },
    roles: {
      planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      worker: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    },
    routing: {
      feature: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      escalation: ["haiku", "sonnet", "opus"],
    },
    pricing: {
      asOf: "2026-10-16",
      sources: ["https://example.com"],
      models: {},
    },
    budgets: {
      l1_replans_per_task: 2,
      l2_per_run: 2,
      planner_format_retries: 2,
    },
    concurrency: { workers },
    permissions: { allow: [], deny: [] },
    sandbox: { enabled: true },
    git: { on_scope_violation: "revert", auto_merge: false },
    instructions: { workers: "none" },
    execution: { strategy: "direct" },
  });
}

function task(
  id: string,
  state: Contracts.TaskState,
  dependsOn: string[] = [],
  write: string[] = [],
  create: string[] = []
): TaskRuntimeState {
  return {
    id: id as Contracts.TaskId,
    state,
    generation: 1,
    attempt: 1,
    depends_on: dependsOn,
    write,
    create,
  };
}

function makeState(tasks: TaskRuntimeState[]): EngineState {
  return {
    run_id: createRunId(),
    state: "EXECUTING",
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
}

describe("engine: scheduler promoteReadyTasks", () => {
  it("keeps a dependent PENDING until its dependency is MERGED", () => {
    const state = makeState([
      task("T1", "MERGING", [], ["src/a.ts"]),
      task("T2", "PENDING", ["T1"], ["src/b.ts"]),
    ]);

    // A passed task is not merged yet, so its dependent does not move: the
    // dependent worktree is built from the run branch and cannot see the change.
    expect(promoteReadyTasks(state)).toEqual([]);

    const merged = makeState([
      task("T1", "MERGED", [], ["src/a.ts"]),
      task("T2", "PENDING", ["T1"], ["src/b.ts"]),
    ]);
    expect(promoteReadyTasks(merged)).toEqual(["T2"]);
  });

  it("releases a diamond dependent only when both paths are merged", () => {
    const state = makeState([
      task("A", "MERGED"),
      task("B", "MERGED", ["A"]),
      task("C", "PENDING", ["A"]),
      task("D", "PENDING", ["B", "C"]),
    ]);
    // C is released because its only dependency is merged; D still waits for C.
    expect(promoteReadyTasks(state)).toEqual(["C"]);

    const bothMerged = makeState([
      task("A", "MERGED"),
      task("B", "MERGED", ["A"]),
      task("C", "MERGED", ["A"]),
      task("D", "PENDING", ["B", "C"]),
    ]);
    expect(promoteReadyTasks(bothMerged)).toEqual(["D"]);

    // A dependency that has not given up yet does not block the dependent.
    const replanning = makeState([
      task("A", "MERGED"),
      task("B", "MERGED", ["A"]),
      task("C", "REPLANNING", ["A"]),
      task("D", "PENDING", ["B", "C"]),
    ]);
    expect(promoteReadyTasks(replanning)).toEqual([]);
    expect(blockedPendingTasks(replanning)).toEqual([]);
  });

  it("blocks a PENDING task whose dependency has given up", () => {
    const state = makeState([
      task("A", "BLOCKED"),
      task("B", "PENDING", ["A"]),
      task("C", "PENDING", ["B"]),
    ]);
    expect(promoteReadyTasks(state)).toEqual([]);
    expect(blockedPendingTasks(state)).toEqual(["B"]);

    const abandoned = makeState([
      task("A", "ABANDONED"),
      task("B", "PENDING", ["A"]),
    ]);
    expect(blockedPendingTasks(abandoned)).toEqual(["B"]);
  });

  it("serialises a READY task that overlaps a task already in flight", () => {
    const settings = makeSettings(2);
    const state = makeState([
      task("T1", "RUNNING", [], ["src/a.ts"], []),
      task("T2", "READY", [], ["src/a.ts"], ["src/a-test.ts"]),
      task("T3", "READY", [], ["src/b.ts"], []),
    ]);

    // T2 cannot start while T1 is working the same file; T3 can.
    expect(scheduleNextTasks(state, settings, 1)).toEqual(["T3"]);

    // Once T1 is merged the overlap is gone.
    const afterMerge = makeState([
      task("T1", "MERGED", [], ["src/a.ts"], []),
      task("T2", "READY", [], ["src/a.ts"], ["src/a-test.ts"]),
      task("T3", "READY", [], ["src/b.ts"], []),
    ]);
    expect(scheduleNextTasks(afterMerge, settings, 0)).toEqual(["T2", "T3"]);
  });

  it("respects the backend concurrency cap", () => {
    const settings = makeSettings(4, 10, 1);
    const state = makeState([
      task("T1", "RUNNING", [], ["src/a.ts"], []),
      task("T2", "READY", [], ["src/b.ts"], []),
    ]);
    expect(scheduleNextTasks(state, settings, 1)).toEqual([]);

    const idle = makeState([task("T1", "READY", [], ["src/a.ts"], [])]);
    expect(scheduleNextTasks(idle, settings, 0)).toEqual(["T1"]);
  });
});
