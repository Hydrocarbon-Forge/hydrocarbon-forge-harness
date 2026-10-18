import { describe, expect, it, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { reduce, type EngineState } from "../../../src/engine/reducer.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import {
  appendUsage,
  ledgerPaths,
  rebuildFromEvents,
  toDelta,
  type LedgerPaths,
} from "../../../src/ledger/usage.js";

function usageRecord(costUsd: number, overrides: Partial<Contracts.UsageRecord> = {}): Contracts.UsageRecord {
  return Contracts.UsageRecord.parse({
    backend: "fake",
    model: "fake-model",
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: costUsd,
    cost_source: "reported",
    at: nowIsoTimestamp(),
    ...overrides,
  });
}

function emptyState(): EngineState {
  return {
    run_id: createRunId(),
    state: "CREATED",
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
}

describe("ledger: usage totals and budget arithmetic", () => {
  // Regression: the worker used to write state.usage.total_usd directly AND
  // let the reducer add the cost again. Two usage events of 0.01 must give a
  // total of exactly 0.02, added once per event by the reducer.
  it("reducer adds usage.cost_usd exactly once per event", () => {
    let state = emptyState();
    const event = (cost: number): Contracts.EngineEvent =>
      ({
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        run_id: state.run_id,
        type: "usage.recorded",
        data: { record: usageRecord(cost), role: "worker" },
      }) as Contracts.EngineEvent;

    state = reduce(state, event(0.01));
    state = reduce(state, event(0.01));

    expect(state.usage.total_usd).toBeCloseTo(0.02, 10);
    expect(state.usage.by_role.worker).toBeCloseTo(0.02, 10);
    // Budget pauses are action decisions now, not reducer decisions.
    expect(state.state).toBe("CREATED");
    expect(state.pause_reason).toBeUndefined();
  });

  it("toDelta: non-cumulative records pass through unchanged", () => {
    const record = usageRecord(0.05);
    const { delta, next } = toDelta(undefined, record, false);
    expect(delta).toBe(record);
    expect(next).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.05,
    });
  });

  it("toDelta: cumulative 10 then 25 gives a delta of 15", () => {
    const first = usageRecord(0.01, { input_tokens: 10, output_tokens: 5 });
    const r1 = toDelta(undefined, first, true);
    expect(r1.delta.cost_usd).toBe(0.01);
    expect(r1.delta.input_tokens).toBe(10);

    const second = usageRecord(0.025, { input_tokens: 25, output_tokens: 8 });
    const r2 = toDelta(r1.next, second, true);
    expect(r2.delta.input_tokens).toBe(15);
    expect(r2.delta.output_tokens).toBe(3);
    expect(r2.delta.cost_usd).toBeCloseTo(0.015, 10);
    // Next totals advance to the cumulative report itself.
    expect(r2.next).toEqual({ input_tokens: 25, output_tokens: 8, cost_usd: 0.025 });
  });

  it("toDelta: a negative difference is set to 0", () => {
    const prev = { input_tokens: 100, output_tokens: 50, cost_usd: 1 };
    const record = usageRecord(0.5, { input_tokens: 40, output_tokens: 20 });
    const { delta } = toDelta(prev, record, true);
    expect(delta.input_tokens).toBe(0);
    expect(delta.output_tokens).toBe(0);
    expect(delta.cost_usd).toBe(0);
  });
});

describe("ledger: usage ledger files", () => {
  let tmpDir: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-ledger-"));
    envBackup = process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = envBackup;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ledgerPaths uses XDG_STATE_HOME when set and the default location otherwise", () => {
    process.env.XDG_STATE_HOME = join(tmpDir, "state");
    const withXdg = ledgerPaths({ projectRoot: tmpDir, globalEnabled: true, env: process.env });
    expect(withXdg.project).toBe(join(tmpDir, ".substrate", "ledger", "usage.jsonl"));
    expect(withXdg.global).toBe(join(tmpDir, "state", "substrate", "usage.jsonl"));

    delete process.env.XDG_STATE_HOME;
    const withoutXdg = ledgerPaths({ projectRoot: tmpDir, globalEnabled: true, env: process.env });
    expect(withoutXdg.global).toBe(
      join(os.homedir(), ".local", "state", "substrate", "usage.jsonl")
    );

    const disabled = ledgerPaths({ projectRoot: tmpDir, globalEnabled: false, env: process.env });
    expect(disabled.global).toBeUndefined();
    expect(disabled.project).toBe(join(tmpDir, ".substrate", "ledger", "usage.jsonl"));
  });

  it("appendUsage writes the project line always and the global line only when enabled", () => {
    const globalBase = join(tmpDir, "state");
    process.env.XDG_STATE_HOME = globalBase;
    const paths = ledgerPaths({ projectRoot: tmpDir, globalEnabled: true, env: process.env });

    const entry: Contracts.UsageLedgerEntry = {
      v: 1,
      ts: new Date().toISOString(),
      project: tmpDir,
      run_id: createRunId(),
      role: "planner",
      backend: "fake",
      model: "fake-model",
      effort: undefined,
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: undefined,
      cache_write_tokens: undefined,
      reasoning_tokens: undefined,
      cost_usd: 0.0001,
      cost_source: "reported",
    };
    appendUsage(entry, paths);

    expect(existsSync(paths.project)).toBe(true);
    expect(readFileSync(paths.project, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(paths.global as string)).toBe(true);

    // Global disabled: no second write happens anywhere else.
    const disabled = ledgerPaths({ projectRoot: tmpDir, globalEnabled: false, env: process.env });
    const entry2 = { ...entry, run_id: createRunId() };
    appendUsage(entry2, disabled);
    const projectLines = readFileSync(disabled.project, "utf8").trim().split("\n");
    expect(projectLines).toHaveLength(2);
    const globalLines = readFileSync(paths.global as string, "utf8").trim().split("\n");
    expect(globalLines).toHaveLength(1);
  });

  it("appends exactly one line per usage.recorded event and rebuildFromEvents restores that invariant", () => {
    const runId = createRunId();
    const runDir = join(tmpDir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });

    const usageEvent = (cost: number, seq: number): string =>
      JSON.stringify({
        v: 1,
        seq,
        ts: new Date().toISOString(),
        run_id: runId,
        type: "usage.recorded",
        data: { record: usageRecord(cost), role: "planner" },
      });
    const otherEvent = (cost: number): string =>
      JSON.stringify({
        v: 1,
        seq: 99,
        ts: new Date().toISOString(),
        run_id: runId,
        type: "batch.started",
        data: {},
      });
    writeFileSync(
      join(runDir, "events.jsonl"),
      [otherEvent(0), usageEvent(0.01, 2), otherEvent(0), usageEvent(0.02, 4), '{"v":1,"seq":', ""].join("\n"),
      "utf8",
    );

    // Pre-existing ledger: stale lines for this run plus lines for another run.
    const paths = ledgerPaths({ projectRoot: tmpDir, globalEnabled: false, env: process.env });
    const otherRunId = createRunId();
    const staleLine = JSON.stringify({
      v: 1, ts: new Date().toISOString(), project: tmpDir, run_id: runId, role: "worker",
      backend: "fake", model: "fake-model", input_tokens: 1, output_tokens: 1, cost_usd: 999, cost_source: "reported",
    });
    const keepLine = JSON.stringify({
      v: 1, ts: new Date().toISOString(), project: tmpDir, run_id: otherRunId, role: "worker",
      backend: "fake", model: "fake-model", input_tokens: 1, output_tokens: 1, cost_usd: 0.5, cost_source: "reported",
    });
    mkdirSync(paths.project.slice(0, paths.project.lastIndexOf("/")), { recursive: true });
    writeFileSync(paths.project, [staleLine, keepLine, '{"v":1,"run_id":' + "", ""].join("\n"), "utf8");

    const appended = rebuildFromEvents(runDir, paths);

    expect(appended).toBe(2);
    const lines = readFileSync(paths.project, "utf8").trim().split("\n");
    // The run's lines were fully replaced: 1 kept foreign line + 2 rebuilt.
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    const runLines = parsed.filter((e) => e.run_id === runId);
    expect(runLines).toHaveLength(2);
    expect(runLines.reduce((n: number, e: any) => n + e.cost_usd, 0)).toBeCloseTo(0.03, 10);
    expect(parsed.some((e) => e.run_id === otherRunId)).toBe(true);
    // No torn lines survive the rewrite.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Events identical to a direct snapshot of usage.recorded stays true forever.
    expect(appended).toBe(2);
  });

  it("with the global mirror enabled, rebuildFromEvents replaces run lines in both files", () => {
    const runId = createRunId();
    const runDir = join(tmpDir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      [JSON.stringify({ v: 1, seq: 1, ts: new Date().toISOString(), run_id: runId, type: "usage.recorded", data: { record: usageRecord(0.1), role: "worker" } }), ""].join("\n"),
      "utf8",
    );
    process.env.XDG_STATE_HOME = join(tmpDir, "state");
    const paths = ledgerPaths({ projectRoot: tmpDir, globalEnabled: true, env: process.env });

    expect(rebuildFromEvents(runDir, paths)).toBe(1);
    for (const file of [paths.project, paths.global as string]) {
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).cost_usd).toBe(0.1);
    }
  });

  it("UsageLedgerEntry validates against the contract schema", () => {
    const entry: Contracts.UsageLedgerEntry = {
      v: 1,
      ts: new Date().toISOString(),
      project: tmpDir,
      run_id: createRunId(),
      task_id: "T1" as Contracts.TaskId,
      generation: 1,
      attempt: 2,
      role: "worker",
      class: "feature",
      backend: "fake",
      model: "fake-model",
      effort: "medium",
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.0001,
      cost_source: "unknown",
    };
    expect(Contracts.UsageLedgerEntry.parse(entry)).toBeTruthy();
  });
});
