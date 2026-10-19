import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import { evaluateEscalation } from "../../../src/engine/ladder.js";
import { executeReplan } from "../../../src/engine/replan.js";
import { reduce, type EngineState, type TaskRuntimeState } from "../../../src/engine/reducer.js";
import { resolveTaskRoute } from "../../../src/roles/router.js";

function makeSettings(overrides: Record<string, unknown> = {}): Contracts.Settings {
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
    sandbox: { enabled: false, network: "deny" },
    git: { on_scope_violation: "revert", branch_prefix: "substrate/", auto_merge: false },
    instructions: { workers: "none" },
    execution: { strategy: "direct" },
    ...overrides,
  });
}

function makeState(
  run_id: Contracts.RunId,
  tasks: Record<string, Partial<TaskRuntimeState>>,
  options: { l2_count?: number; l2_done?: boolean; total_usd?: number } = {},
): EngineState {
  const state: EngineState = {
    run_id,
    state: "EXECUTING",
    tasks: {},
    usage: { total_usd: options.total_usd ?? 0, by_role: {} },
    checkpoints: [],
    l2_count: options.l2_count ?? 0,
    l2_done: options.l2_done ?? false,
  };

  for (const [id, task] of Object.entries(tasks)) {
    state.tasks[id] = { id, state: "FAILED", generation: 1, attempt: 1, ...task };
  }

  return state;
}

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

function makePacket(
  run_id: Contracts.RunId,
  task_id: string,
  generation: number,
  failure_class: Contracts.FailureClass,
  dependents: string[] = [],
): Contracts.FailurePacket {
  return Contracts.FailurePacket.parse({
    run_id,
    task_id,
    generation,
    failure_class,
    spec_path: `tasks/${task_id}.md`,
    attempts: [],
    diff: { stat: "", patch_path: `packets/${task_id}-g${generation}.patch`, truncated: false },
    verify_output: [],
    scope_violations: [],
    worker_summary: "",
    related_contracts: [],
    dependents,
  });
}

describe("R3.5 escalation ladder", () => {
  it("walks L1, L1, then L2, then L3 as generations and the L2 counter are consumed", () => {
    const settings = makeSettings();
    const runId = createRunId();

    // Generation 1 failing on its second attempt is the first L1: the ladder plans
    // generation 2, which is the router's tier for that generation.
    let state = makeState(runId, { T1: { generation: 1, attempt: 2 } });
    const first = evaluateEscalation(state, "T1", "verify_failed", settings);
    expect(first.level).toBe("L1");
    if (first.level !== "L1") return;
    expect(first.generation).toBe(2);
    expect(first.route).toEqual(resolveTaskRoute("feature", 2, settings));

    // Generation 2 is still inside the L1 cap, so the ladder replans to generation 3.
    state = makeState(runId, { T1: { generation: 2, attempt: 2 } });
    const second = evaluateEscalation(state, "T1", "verify_failed", settings);
    expect(second.level).toBe("L1");
    if (second.level !== "L1") return;
    expect(second.generation).toBe(3);

    // Generation 3 is past l1_replans_per_task, so the ladder moves to L2 and counts the
    // amendment through the typed counter on the state.
    // The attempt is the second one, so the L0 heal rule does not apply.
    state = makeState(runId, { T1: { generation: 3, attempt: 2 } });
    expect(evaluateEscalation(state, "T1", "verify_failed", settings).level).toBe("L2");

    state = reduce(state, makeEvent(runId, 1, "replan.l2", { task_id: "T1", generation: 4 }));
    expect(state.l2_count).toBe(1);
    expect(state.l2_done).toBe(true);
    expect(evaluateEscalation(state, "T1", "verify_failed", settings).level).toBe("L2");

    // The second amendment reaches the run cap, and the ladder pauses for a human.
    state = reduce(state, makeEvent(runId, 2, "replan.l2", { task_id: "T1", generation: 5 }));
    expect(state.l2_count).toBe(2);
    const third = evaluateEscalation(state, "T1", "verify_failed", settings);
    expect(third.level).toBe("L3");
    if (third.level !== "L3") return;
    expect(third.reason).toBe("needs_human");
  });

  it("uses the task class for the L1 route rather than a fixed tier table", () => {
    const settings = makeSettings({
      routing: {
        feature: { backend: "claude", model: "claude-haiku-5-5", effort: "low" },
        fix: { backend: "claude", model: "claude-opus-5-5", effort: "high" },
        escalation: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
      },
    });
    const runId = createRunId();
    const state = makeState(runId, { T1: { generation: 1, attempt: 2 } });

    const feature = evaluateEscalation(state, "T1", "verify_failed", settings, "feature");
    const fix = evaluateEscalation(state, "T1", "verify_failed", settings, "fix");

    expect(feature.level).toBe("L1");
    expect(fix.level).toBe("L1");
    if (feature.level !== "L1" || fix.level !== "L1") return;

    expect(feature.route).toEqual(resolveTaskRoute("feature", 2, settings));
    expect(fix.route).toEqual(resolveTaskRoute("fix", 2, settings));
    expect(fix.route.model).toBe("claude-opus-5-5");
    expect(feature.route.model).toBe("claude-sonnet-5-5");
  });

  it("the run budget never changes what the ladder decides", () => {
    const settings = makeSettings({
      budgets: {
        run: { max_usd: 10 },
        task: { max_usd: 1.0 },
        l1_replans_per_task: 2,
        l2_per_run: 2,
        planner_format_retries: 2,
        approval_threshold_usd: 2,
      },
    });
    const runId = createRunId();

    // Spend is far past the run budget. The ladder has no usage branch: the caller pauses
    // the run, the ladder only classifies the failure.
    const state = makeState(runId, { T1: { generation: 1, attempt: 2 } }, { total_usd: 100 });
    const action = evaluateEscalation(state, "T1", "verify_failed", settings);
    expect(action.level).toBe("L1");

    // A per-task budget failure is a failure like any other, so it still goes to L1.
    const budgetAction = evaluateEscalation(state, "T1", "budget_exceeded", settings);
    expect(budgetAction.level).toBe("L1");
  });

  it("tasks.invalidated returns tasks to PENDING and never touches a merged task", () => {
    const runId = createRunId();
    const state = makeState(runId, {
      T1: { generation: 3, attempt: 1 },
      T2: { state: "PENDING", generation: 1, attempt: 1, depends_on: ["T1"] },
      T3: { state: "MERGED", generation: 1, attempt: 1, depends_on: ["T1"] },
    });

    const next = reduce(state, makeEvent(runId, 1, "tasks.invalidated", { task_ids: ["T3", "T2"] }));
    expect(next.tasks["T2"].state).toBe("PENDING");
    expect(next.tasks["T3"].state).toBe("MERGED");
    // Invalidated work is promoted by the scheduler, not readied here.
    expect(next.tasks["T2"].state).not.toBe("READY");
    // The ladder sees the failed task itself, which is not invalidated by the amendment.
    expect(next.tasks["T1"].state).toBe("FAILED");
    expect(state.tasks["T2"].state).toBe("PENDING");
  });

  it("a permission denial blocks the failed task and pauses the run", async () => {
    const runId = createRunId();
    const runDir = mkdtempSync(join(tmpdir(), "substrate-l3-pause-"));

    try {
      const state = makeState(runId, { T1: { generation: 1, attempt: 1 } });
      const events: Contracts.EngineEvent[] = [];

      const result = await executeReplan({
        runId,
        taskId: "T1",
        packet: makePacket(runId, "T1", 1, "permission_denied"),
        state,
        settings: makeSettings(),
        runDir,
        repoRoot: runDir,
        baseRef: "main",
        onEvent: (event) => events.push(event),
      });

      expect(result.status).toBe("paused");
      expect(result.pauseReason).toBe("permission_denied");
      expect(events.map((e) => e.type)).toEqual(["task.blocked", "run.paused"]);

      const blocked = reduce(state, events[0]);
      expect(blocked.tasks["T1"].state).toBe("BLOCKED");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("reaching the L2 cap blocks the task and pauses for a human", async () => {
    const runId = createRunId();
    const runDir = mkdtempSync(join(tmpdir(), "substrate-l3-cap-"));

    try {
      const state = makeState(runId, { T1: { generation: 3, attempt: 2 } }, { l2_count: 2, l2_done: true });
      const events: Contracts.EngineEvent[] = [];

      const result = await executeReplan({
        runId,
        taskId: "T1",
        packet: makePacket(runId, "T1", 3, "verify_failed"),
        state,
        settings: makeSettings(),
        runDir,
        repoRoot: runDir,
        baseRef: "main",
        onEvent: (event) => events.push(event),
      });

      expect(result.level).toBe("L3");
      expect(result.pauseReason).toBe("needs_human");
      expect(events.map((e) => e.type)).toEqual(["task.blocked", "run.paused"]);
      expect((events[1].data as { reason: string }).reason).toBe("needs_human");

      const blocked = reduce(state, events[0]);
      expect(blocked.tasks["T1"].state).toBe("BLOCKED");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
