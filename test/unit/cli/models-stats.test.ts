/*
 * Expected numbers, worked by hand from test/fixtures/ledger/stats-sample.jsonl
 * and test/fixtures/runs/stats-run/events.jsonl (run stats-run).
 *
 * Task generations (run_id/task_id/generation), with model, backend, outcome:
 *   T0/1  model-alpha  claude    attempt 1 verify passed, task.passed   (2026-06-01, old)
 *   T1/1  model-alpha  claude    attempt 1 verify passed, task.passed
 *   T2/1  model-alpha  claude    attempt 1 failed, task.healing, attempt 2 passed, task.passed
 *   T3/1  model-alpha  claude    attempt 1 failed, replanned into generation 2
 *   T3/2  model-alpha  claude    attempt 1 passed, task.passed
 *   T4/1  model-beta   opencode  attempt 1 passed, task.passed
 *   T5/1  model-beta   opencode  attempt 1 failed, never passes
 * Planner rows (no task_id) for model-alpha and model-epsilon are ignored.
 * model-epsilon has only a planner row, so it has zero generations.
 *
 * model-alpha, no since (5 generations):
 *   tasks = 5
 *   first_pass_rate = 3/5 (T0, T1, T3/2) = 0.6
 *   heal_rate = 1/5 (T2) = 0.2
 *   replans = 1 (T3/2 replanned from T3/1, which ran on alpha)
 *   input tokens = 100+1000+(2000+500)+3000+1500 = 8100, /5 = 1620
 *   output tokens = 10+200+(400+100)+600+250 = 1560, /5 = 312
 *   passed generations T0, T1, T2, T3/2: cost 2.00 + 0.10 + 0.25 + 0.30 = 2.65, /4 = 0.6625
 *   T3/1 cost 0.90 failed and is excluded from the average
 *   cost_unknown = false
 *
 * model-alpha, since = 2026-09-01T00:00:00Z (T0 drops out, 4 generations):
 *   tasks = 4
 *   first_pass_rate = 2/4 (T1, T3/2) = 0.5
 *   heal_rate = 1/4 = 0.25
 *   replans = 1
 *   input tokens = 1000+2500+3000+1500 = 8000, /4 = 2000
 *   output tokens = 200+500+600+250 = 1550, /4 = 387.5
 *   passed generations T1, T2, T3/2: cost 0.10 + 0.25 + 0.30 = 0.65, /3 = 0.2166666...
 *
 * model-beta, no since or since (2 generations, both in window):
 *   tasks = 2
 *   first_pass_rate = 1/2 = 0.5
 *   heal_rate = 0
 *   replans = 0
 *   input tokens = (400+50+300)/2 = 375
 *   output tokens = (100+10+50)/2 = 80
 *   passed generation T4/1: cost 0.12 (its reviewer row has cost 0, source unknown), /1 = 0.12
 *   cost_unknown = true
 *
 * model-epsilon: tasks 0, note "no data", all rates and averages null, replans 0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { modelStats } from "../../../src/cli/model-catalog.js";
import { distinctTasks } from "../../../src/ledger/usage.js";

const FIXTURE_DIR = join(__dirname, "..", "..", "fixtures");
const LEDGER_FIXTURE = join(FIXTURE_DIR, "ledger", "stats-sample.jsonl");
const EVENTS_FIXTURE = join(FIXTURE_DIR, "runs", "stats-run", "events.jsonl");

const SINCE_2026_09_01 = Date.parse("2026-09-01T00:00:00Z");

let projectRoot: string;

function setupProject(extraEvents = ""): void {
  mkdirSync(join(projectRoot, ".substrate", "ledger"), { recursive: true });
  mkdirSync(join(projectRoot, ".substrate", "runs", "stats-run"), { recursive: true });
  writeFileSync(join(projectRoot, ".substrate", "ledger", "usage.jsonl"), readFileSync(LEDGER_FIXTURE, "utf8"));
  const events = readFileSync(EVENTS_FIXTURE, "utf8");
  writeFileSync(
    join(projectRoot, ".substrate", "runs", "stats-run", "events.jsonl"),
    events + extraEvents
  );
}

function statsFor(model: string, since?: number) {
  const rows = modelStats({ projectRoot, since });
  const row = rows.find((r: { model: string }) => r.model === model);
  if (row === undefined) throw new Error(`no stats row for ${model}`);
  return row;
}

function eventLine(seq: number, ts: string, type: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, seq, ts, run_id: "edge-run", type, data })}\n`;
}

function writeEdgeRun(events: string[]): void {
  mkdirSync(join(projectRoot, ".substrate", "runs", "edge-run"), { recursive: true });
  writeFileSync(join(projectRoot, ".substrate", "runs", "edge-run", "events.jsonl"), events.join(""));
}

describe("models --stats: modelStats over the fixture ledger and run events", () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "substrate-models-stats-"));
    setupProject();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("first-pass and heal rates over all generations of model-alpha", () => {
    const alpha = statsFor("model-alpha");
    expect(alpha.provider).toBe("claude");
    expect(alpha.tasks).toBe(5);
    expect(alpha.first_pass_rate).toBeCloseTo(0.6, 10);
    expect(alpha.heal_rate).toBeCloseTo(0.2, 10);
    expect(alpha.replans).toBe(1);
  });

  it("first-pass and heal rates for model-beta", () => {
    const beta = statsFor("model-beta");
    expect(beta.provider).toBe("opencode");
    expect(beta.tasks).toBe(2);
    expect(beta.first_pass_rate).toBeCloseTo(0.5, 10);
    expect(beta.heal_rate).toBe(0);
    expect(beta.replans).toBe(0);
  });

  it("averages tokens over all task generations, ignoring planner rows", () => {
    const alpha = statsFor("model-alpha");
    expect(alpha.avg_input_tokens).toBeCloseTo(1620, 10);
    expect(alpha.avg_output_tokens).toBeCloseTo(312, 10);

    const beta = statsFor("model-beta");
    expect(beta.avg_input_tokens).toBeCloseTo(375, 10);
    expect(beta.avg_output_tokens).toBeCloseTo(80, 10);
  });

  it("average cost is over passed generations only, excluding the failed 0.90 generation", () => {
    const alpha = statsFor("model-alpha");
    expect(alpha.avg_cost_per_passed_task).toBeCloseTo(0.6625, 10);
    expect(alpha.cost_unknown).toBe(false);
  });

  it("an unknown cost_source on a passed generation sets cost_unknown", () => {
    const beta = statsFor("model-beta");
    expect(beta.avg_cost_per_passed_task).toBeCloseTo(0.12, 10);
    expect(beta.cost_unknown).toBe(true);
  });

  it("a model with no task generations gets note 'no data' and null rates", () => {
    const epsilon = statsFor("model-epsilon");
    expect(epsilon.tasks).toBe(0);
    expect(epsilon.note).toBe("no data");
    expect(epsilon.first_pass_rate).toBeNull();
    expect(epsilon.heal_rate).toBeNull();
    expect(epsilon.avg_input_tokens).toBeNull();
    expect(epsilon.avg_output_tokens).toBeNull();
    expect(epsilon.avg_cost_per_passed_task).toBeNull();
    expect(epsilon.replans).toBe(0);
  });

  it("a since cutoff drops the old generation from the ledger and the events", () => {
    const alpha = statsFor("model-alpha", SINCE_2026_09_01);
    expect(alpha.tasks).toBe(4);
    expect(alpha.first_pass_rate).toBeCloseTo(0.5, 10);
    expect(alpha.heal_rate).toBeCloseTo(0.25, 10);
    expect(alpha.replans).toBe(1);
    expect(alpha.avg_input_tokens).toBeCloseTo(2000, 10);
    expect(alpha.avg_output_tokens).toBeCloseTo(387.5, 10);
    expect(alpha.avg_cost_per_passed_task).toBeCloseTo(0.65 / 3, 10);
  });

  it("a since cutoff leaves models whose rows are all inside the window unchanged", () => {
    const beta = statsFor("model-beta", SINCE_2026_09_01);
    expect(beta.tasks).toBe(2);
    expect(beta.first_pass_rate).toBeCloseTo(0.5, 10);
    expect(beta.avg_cost_per_passed_task).toBeCloseTo(0.12, 10);
    expect(beta.cost_unknown).toBe(true);
  });

  it("a malformed event line is skipped and does not change any value", () => {
    const base = modelStats({ projectRoot });
    appendFileSync(
      join(projectRoot, ".substrate", "runs", "stats-run", "events.jsonl"),
      '{"v":1,"seq":16,"ts":"2026-09-23T13:00:00Z","run_id":"stats-run","type":"task.verify.fin\n' +
        "this line is not json at all\n"
    );
    const withGarbage = modelStats({ projectRoot });
    expect(withGarbage).toEqual(base);
    expect(statsFor("model-alpha").tasks).toBe(5);
  });
});

describe("models --stats: edge cases from the spec", () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "substrate-models-stats-edge-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("a run with events but no ledger counts its tasks and leaves tokens and cost null", () => {
    const record = {
      backend: "claude",
      model: "model-zeta",
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.5,
      cost_source: "reported",
      at: "2026-09-23T10:00:00Z",
    };
    writeEdgeRun([
      eventLine(1, "2026-09-23T10:00:00Z", "usage.recorded", { record, role: "worker", task_id: "Z1", generation: 1 }),
      eventLine(2, "2026-09-23T10:00:01Z", "task.verify.finished", { task_id: "Z1", generation: 1, attempt: 1, passed: true }),
      eventLine(3, "2026-09-23T10:00:02Z", "task.passed", { task_id: "Z1", generation: 1, attempt: 1 }),
    ]);

    const zeta = statsFor("model-zeta");
    expect(zeta.provider).toBe("claude");
    expect(zeta.tasks).toBe(1);
    expect(zeta.first_pass_rate).toBe(1);
    expect(zeta.heal_rate).toBe(0);
    expect(zeta.avg_input_tokens).toBeNull();
    expect(zeta.avg_output_tokens).toBeNull();
    expect(zeta.avg_cost_per_passed_task).toBeNull();
    expect(zeta.note).toBeUndefined();
  });

  it("a model that appears only in a replan has tasks 0 and note 'no data'", () => {
    mkdirSync(join(projectRoot, ".substrate", "ledger"), { recursive: true });
    const row = {
      v: 1,
      ts: "2026-06-01T10:00:00Z",
      project: "/fixture-project",
      run_id: "edge-run",
      task_id: "E1",
      generation: 1,
      attempt: 1,
      role: "worker",
      backend: "opencode",
      model: "model-eta",
      input_tokens: 100,
      output_tokens: 10,
      cost_usd: 0.1,
      cost_source: "reported",
    };
    writeFileSync(join(projectRoot, ".substrate", "ledger", "usage.jsonl"), `${JSON.stringify(Contracts.UsageLedgerEntry.parse(row))}\n`);
    writeEdgeRun([
      eventLine(1, "2026-06-01T10:00:01Z", "task.verify.finished", { task_id: "E1", generation: 1, attempt: 1, passed: false }),
      eventLine(2, "2026-09-23T10:00:00Z", "task.replanned", { task_id: "E1", generation: 2 }),
    ]);

    const eta = statsFor("model-eta", SINCE_2026_09_01);
    expect(eta.tasks).toBe(0);
    expect(eta.note).toBe("no data");
    expect(eta.replans).toBe(1);
    expect(eta.first_pass_rate).toBeNull();
    expect(eta.heal_rate).toBeNull();
    expect(eta.avg_input_tokens).toBeNull();
    expect(eta.avg_output_tokens).toBeNull();
    expect(eta.avg_cost_per_passed_task).toBeNull();
  });
});

describe("usage: distinctTasks groups ledger rows by run, task and generation", () => {
  it("keys task generations and skips rows with no task_id", () => {
    const lines = readFileSync(LEDGER_FIXTURE, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const entries = lines.map((line) => Contracts.UsageLedgerEntry.parse(JSON.parse(line)));
    expect(entries).toHaveLength(11);

    const groups = distinctTasks(entries);
    expect([...groups.keys()].sort()).toEqual([
      "stats-run/T0/1",
      "stats-run/T1/1",
      "stats-run/T2/1",
      "stats-run/T3/1",
      "stats-run/T3/2",
      "stats-run/T4/1",
      "stats-run/T5/1",
    ]);
    expect(groups.get("stats-run/T2/1")).toHaveLength(2);
    expect(groups.get("stats-run/T4/1")).toHaveLength(2);
    expect(groups.get("stats-run/T3/2")).toHaveLength(1);

    const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
    expect(total).toBe(9);
  });
});
