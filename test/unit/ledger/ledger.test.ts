import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import {
  aggregateLedger,
  estimateRunCost,
  type CostSummary,
  type LedgerEntry,
} from "../../../src/ledger/index.js";

function makeSettings(approvalThreshold = 2.0, defaultTaskBudget = 0.5): Contracts.Settings {
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
      l1_replans_per_task: 2,
      l2_per_run: 2,
      planner_format_retries: 2,
    },
    concurrency: { workers: 3 },
    permissions: { allow: [], deny: [] },
    sandbox: { enabled: true },
    git: { on_scope_violation: "revert", auto_merge: false },
    instructions: { workers: "none" },
    execution: { strategy: "direct" },
  });
}

function makeManifest(tasks: Array<{ id: Contracts.TaskId; spec: string }>): Contracts.Manifest {
  return Contracts.Manifest.parse({
    version: 1,
    run_id: createRunId(),
    goal: "Test run",
    base_ref: "main",
    setup: [{ run: "npm ci", timeout_s: 60 }],
    contracts: { files: ["src/index.ts"], typecheck: [{ run: "npm run typecheck", timeout_s: 30 }] },
    integration_verify: [{ run: "npm test", timeout_s: 60 }],
    tasks,
  });
}

function makeUsageRecord(cost_usd: number, model = "claude-sonnet-5-5"): Contracts.UsageRecord {
  return {
    backend: "claude",
    model,
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd,
    cost_source: "reported",
    at: nowIsoTimestamp(),
  };
}

describe("ledger: estimateRunCost pre-flight cost estimation", () => {
  it("falls back to default class budget when ledger is empty", () => {
    const settings = makeSettings(5.0, 0.5); // default task budget $0.50, approval threshold $5.00
    const manifest = makeManifest([
      { id: "TaskA", spec: "tasks/A.md" },
      { id: "TaskB", spec: "tasks/B.md" },
    ]);

    const result = estimateRunCost(manifest, []);

    // 2 tasks * ~0.50 * retry multiplier (>= 1.0)
    expect(result.estimated_usd).toBeGreaterThanOrEqual(1.0);
  });

  it("reports the estimate as advisory: no approval flag, whatever the estimate", () => {
    const manifest = makeManifest([
      { id: "TaskA", spec: "tasks/A.md" },
      { id: "TaskB", spec: "tasks/B.md" },
    ]);

    const result = estimateRunCost(manifest, []);

    expect(result.estimated_usd).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("requires_approval");
  });

  it("uses historical median cost per class from historical ledger entries", () => {
    const runId = createRunId();
    const settings = makeSettings(10.0, 1.0);
    const manifest = makeManifest([{ id: "TaskA", spec: "tasks/A.md" }]);

    // Historical ledger with feature class median cost of ~0.30
    const ledger: LedgerEntry[] = [
      {
        run_id: runId,
        task_id: "OldTask1",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.20),
      },
      {
        run_id: runId,
        task_id: "OldTask2",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.30),
      },
      {
        run_id: runId,
        task_id: "OldTask3",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.40),
      },
    ];

    const result = estimateRunCost(manifest, ledger);

    // Estimated cost based on historical median ~0.30 * retry factor (approx 0.30-0.45)
    expect(result.estimated_usd).toBeCloseTo(0.36, 1);
  });
});

describe("ledger: aggregateLedger metrics and summaries", () => {
  it("aggregates totals by role, class, and model tier", () => {
    const runId = createRunId();
    const entries: LedgerEntry[] = [
      {
        run_id: runId,
        task_id: "TaskA",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.50, "claude-sonnet-5-5"),
      },
      {
        run_id: runId,
        task_id: "TaskB",
        role: "worker",
        backend: "claude",
        model: "claude-haiku-5-5",
        task_class: "mechanical",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.10, "claude-haiku-5-5"),
      },
      {
        run_id: runId,
        role: "planner",
        backend: "claude",
        model: "claude-opus-5-5",
        usage: makeUsageRecord(2.00, "claude-opus-5-5"),
      },
    ];

    const summary = aggregateLedger(entries);

    expect(summary.total_usd).toBeCloseTo(2.60, 4);
    expect(summary.by_role["worker"]).toBeCloseTo(0.60, 4);
    expect(summary.by_role["planner"]).toBeCloseTo(2.00, 4);
    expect(summary.by_class["feature"]).toBeCloseTo(0.50, 4);
    expect(summary.by_class["mechanical"]).toBeCloseTo(0.10, 4);
  });

  it("calculates first_pass_rate, heal_rate, and replans_per_task accurately", () => {
    const runId = createRunId();
    const entries: LedgerEntry[] = [
      // TaskA: Passed first pass (gen 1, attempt 1)
      {
        run_id: runId,
        task_id: "TaskA",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.20),
      },
      // TaskB: Required healing (gen 1, attempt 1 then attempt 2)
      {
        run_id: runId,
        task_id: "TaskB",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.20),
      },
      {
        run_id: runId,
        task_id: "TaskB",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 2, // Healed
        usage: makeUsageRecord(0.20),
      },
      // TaskC: Required replan (generation 1, then generation 2)
      {
        run_id: runId,
        task_id: "TaskC",
        role: "worker",
        backend: "claude",
        model: "claude-haiku-5-5",
        task_class: "feature",
        generation: 1,
        attempt: 1,
        usage: makeUsageRecord(0.10),
      },
      {
        run_id: runId,
        task_id: "TaskC",
        role: "worker",
        backend: "claude",
        model: "claude-sonnet-5-5",
        task_class: "feature",
        generation: 2, // Replan
        attempt: 1,
        usage: makeUsageRecord(0.30),
      },
    ];

    const result = aggregateLedger(entries);

    // 3 distinct tasks: TaskA (first pass), TaskB (healed), TaskC (replanned)
    // First pass rate: 1/3
    expect(result.first_pass_rate).toBeCloseTo(1 / 3, 2);
    // Heal rate: 1/3
    expect(result.heal_rate).toBeCloseTo(1 / 3, 2);
    // Replans per task: TaskC had 1 replan
    expect(result.replans_per_task["TaskC"]).toBe(1);
    expect(result.replans_per_task["TaskA"] ?? 0).toBe(0);
  });

  it("handles empty ledger returning zero totals gracefully", () => {
    const summary = aggregateLedger([]);
    expect(summary.total_usd).toBe(0);
    expect(summary.by_role).toEqual({});
    expect(summary.by_class).toEqual({});
    expect(summary.first_pass_rate).toBe(0);
    expect(summary.heal_rate).toBe(0);
    expect(summary.replans_per_task).toEqual({});
  });
});
