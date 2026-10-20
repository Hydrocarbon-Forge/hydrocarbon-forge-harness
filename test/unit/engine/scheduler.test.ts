import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import { detectOverlap, scheduleNextTasks } from "../../../src/engine/scheduler.js";
import { type EngineState } from "../../../src/engine/reducer.js";

function makeSettings(workers = 3, maxUsd = 10): Contracts.Settings {
  return Contracts.Settings.parse({
    backends: {},
    roles: {
      planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
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
      run: { max_usd: maxUsd },
      task: { max_usd: 1.0 },
      l1_replans_per_task: 2,
      l2_per_run: 2,
      planner_format_retries: 2,
      approval_threshold_usd: 2,
    },
    concurrency: { workers },
    permissions: { allow: [], deny: [] },
    sandbox: { enabled: true },
    git: { on_scope_violation: "revert", auto_merge: false },
    instructions: { workers: "none" },
    execution: { strategy: "direct" },
  });
}

function makeState(run_id = createRunId(), stateName: Contracts.RunState = "EXECUTING"): EngineState {
  return {
    run_id,
    state: stateName,
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
}

describe("engine: scheduler detectOverlap glob intersection", () => {
  it("identifies no overlap between tasks with completely disjoint file sets", () => {
    const tasks = [
      { id: "TaskA", write: ["src/a.ts"], create: ["src/a-helper.ts"] },
      { id: "TaskB", write: ["src/b.ts"], create: ["src/b-helper.ts"] },
    ];
    const overlaps = detectOverlap(tasks);

    expect(overlaps.get("TaskA")?.size ?? 0).toBe(0);
    expect(overlaps.get("TaskB")?.size ?? 0).toBe(0);
  });

  it("detects exact file overlap between write sets", () => {
    const tasks = [
      { id: "TaskA", write: ["src/shared.ts"], create: [] },
      { id: "TaskB", write: ["src/shared.ts"], create: [] },
    ];
    const overlaps = detectOverlap(tasks);

    expect(overlaps.get("TaskA")?.has("TaskB")).toBe(true);
    expect(overlaps.get("TaskB")?.has("TaskA")).toBe(true);
  });

  it("detects overlap between write and create sets", () => {
    const tasks = [
      { id: "TaskA", write: ["src/generated.ts"], create: [] },
      { id: "TaskB", write: [], create: ["src/generated.ts"] },
    ];
    const overlaps = detectOverlap(tasks);

    expect(overlaps.get("TaskA")?.has("TaskB")).toBe(true);
    expect(overlaps.get("TaskB")?.has("TaskA")).toBe(true);
  });

  it("detects wildcard glob intersections: src/** vs src/foo.ts", () => {
    const tasks = [
      { id: "TaskA", write: ["src/**"], create: [] },
      { id: "TaskB", write: ["src/foo.ts"], create: [] },
    ];
    const overlaps = detectOverlap(tasks);

    expect(overlaps.get("TaskA")?.has("TaskB")).toBe(true);
    expect(overlaps.get("TaskB")?.has("TaskA")).toBe(true);
  });

  it("distinguishes non-overlapping wildcard subdirectories", () => {
    const tasks = [
      { id: "TaskA", write: ["src/store/**"], create: [] },
      { id: "TaskB", write: ["src/engine/**"], create: [] },
    ];
    const overlaps = detectOverlap(tasks);

    expect(overlaps.get("TaskA")?.has("TaskB")).toBeFalsy();
    expect(overlaps.get("TaskB")?.has("TaskA")).toBeFalsy();
  });
});

describe("engine: scheduler scheduleNextTasks concurrency and serialization", () => {
  it("yields ready tasks up to concurrency worker limit", () => {
    const settings = makeSettings(2); // 2 workers
    const state = makeState();
    state.tasks = {
      TaskA: { id: "TaskA", state: "READY", generation: 1, attempt: 1 },
      TaskB: { id: "TaskB", state: "READY", generation: 1, attempt: 1 },
      TaskC: { id: "TaskC", state: "READY", generation: 1, attempt: 1 },
    };

    // Active count 0, 2 worker slots available
    const next = scheduleNextTasks(state, settings, 0);
    expect(next).toHaveLength(2);
    expect(next).toEqual(expect.arrayContaining(["TaskA", "TaskB"]));
  });

  it("yields empty array when active worker count equals or exceeds concurrency limit", () => {
    const settings = makeSettings(2);
    const state = makeState();
    state.tasks = {
      TaskA: { id: "TaskA", state: "READY", generation: 1, attempt: 1 },
    };

    // Active count 2 with worker limit 2 -> 0 available slots
    const next = scheduleNextTasks(state, settings, 2);
    expect(next).toEqual([]);
  });

  it("only schedules tasks that are in READY state", () => {
    const settings = makeSettings(3);
    const state = makeState();
    state.tasks = {
      TaskA: { id: "TaskA", state: "PENDING", generation: 1, attempt: 1 },
      TaskB: { id: "TaskB", state: "RUNNING", generation: 1, attempt: 1 },
      TaskC: { id: "TaskC", state: "READY", generation: 1, attempt: 1 },
      TaskD: { id: "TaskD", state: "BLOCKED", generation: 1, attempt: 1 },
      TaskE: { id: "TaskE", state: "PASSED", generation: 1, attempt: 1 },
    };

    const next = scheduleNextTasks(state, settings, 1);
    expect(next).toEqual(["TaskC"]);
  });

  it("yields empty array when run is in PAUSED state", () => {
    const settings = makeSettings(3);
    const state = makeState(undefined, "PAUSED");
    state.pause_reason = "budget_exhausted";
    state.tasks = {
      TaskA: { id: "TaskA", state: "READY", generation: 1, attempt: 1 },
    };

    const next = scheduleNextTasks(state, settings, 0);
    expect(next).toEqual([]);
  });

  it("yields empty array when run budget is exhausted", () => {
    const settings = makeSettings(3, 5.0); // max_usd 5.0
    const state = makeState();
    state.usage.total_usd = 5.5; // Exceeded
    state.tasks = {
      TaskA: { id: "TaskA", state: "READY", generation: 1, attempt: 1 },
    };

    const next = scheduleNextTasks(state, settings, 0);
    expect(next).toEqual([]);
  });
});
