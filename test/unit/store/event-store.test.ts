import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import { EventStore } from "../../../src/store/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "substrate-event-store-"));
}

function makeEvent(
  run_id: Contracts.RunId,
  seq: number,
  type = "run.created",
  data: unknown = { run_id },
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

describe("store: EventStore append and schema validation", () => {
  it("appends valid EngineEvent and persists to .substrate/runs/<run_id>/events.jsonl", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const store = new EventStore(runId, { baseDir });

    const event1 = makeEvent(runId, 1, "run.created", { run_id: runId });
    await store.append(event1);

    const logPath = join(baseDir, ".substrate", "runs", runId, "events.jsonl");
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(event1);

    const event2 = makeEvent(runId, 2, "run.routed", { mode: "solo" });
    await store.append(event2);

    const readBack = await store.readAll();
    expect(readBack).toHaveLength(2);
    expect(readBack[0]).toEqual(event1);
    expect(readBack[1]).toEqual(event2);
  });

  it("enforces monotonic sequence numbering: seq must be lastSeq + 1", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const store = new EventStore(runId, { baseDir });

    // Initial event must be seq 1
    const invalidStart = makeEvent(runId, 2, "run.created");
    await expect(store.append(invalidStart)).rejects.toThrow(/sequence|monotonic/i);

    const validFirst = makeEvent(runId, 1, "run.created");
    await store.append(validFirst);

    // Duplicate seq rejected
    const duplicateSeq = makeEvent(runId, 1, "run.routed");
    await expect(store.append(duplicateSeq)).rejects.toThrow(/sequence|monotonic/i);

    // Skipping seq rejected
    const skippedSeq = makeEvent(runId, 3, "run.routed");
    await expect(store.append(skippedSeq)).rejects.toThrow(/sequence|monotonic/i);

    // Decreasing seq rejected
    const backwardSeq = makeEvent(runId, 0, "run.routed");
    await expect(store.append(backwardSeq)).rejects.toThrow(/sequence|monotonic/i);
  });

  it("rejects events failing EngineEvent contract schema", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const store = new EventStore(runId, { baseDir });

    const badEvents = [
      { v: 2, seq: 1, ts: nowIsoTimestamp(), run_id: runId, type: "run.created", data: {} },
      { v: 1, seq: "1", ts: nowIsoTimestamp(), run_id: runId, type: "run.created", data: {} },
      { v: 1, seq: 1, ts: "invalid-time", run_id: "bad_run_id", type: "run.created", data: {} },
      { v: 1, seq: 1, ts: nowIsoTimestamp(), run_id: runId, type: 123, data: {} },
      { v: 1, seq: 1, ts: nowIsoTimestamp(), type: "run.created", data: {} },
    ];

    for (const bad of badEvents) {
      await expect(store.append(bad as unknown as Contracts.EngineEvent)).rejects.toThrow();
    }
  });

  it("rejects events belonging to a different run_id", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const otherRunId = createRunId();
    const store = new EventStore(runId, { baseDir });

    const mismatched = makeEvent(otherRunId, 1, "run.created");
    await expect(store.append(mismatched)).rejects.toThrow(/run_id/i);
  });
});

describe("store: EventStore readAll and corruption recovery", () => {
  it("returns empty array when log file does not exist or is empty", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const store = new EventStore(runId, { baseDir });

    const events = await store.readAll();
    expect(events).toEqual([]);
  });

  it("recovers from torn-tail JSON from ungraceful kill: ignores truncated last line", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const logDir = join(baseDir, ".substrate", "runs", runId);
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "events.jsonl");

    const event1 = makeEvent(runId, 1, "run.created");
    const event2 = makeEvent(runId, 2, "task.ready", { task_id: "TaskA" });
    const line1 = JSON.stringify(event1);
    const line2 = JSON.stringify(event2);
    const tornLine = `{"v":1,"seq":3,"ts":"2026-10-16T18:00:00.000Z","run_id":"${runId}","type":"task.session.star`;

    writeFileSync(logPath, `${line1}\n${line2}\n${tornLine}`);

    const store = new EventStore(runId, { baseDir });
    const readBack = await store.readAll();

    expect(readBack).toHaveLength(2);
    expect(readBack[0]).toEqual(event1);
    expect(readBack[1]).toEqual(event2);
  });

  it("halts and throws fatal corruption error on middle-line invalid JSON", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const logDir = join(baseDir, ".substrate", "runs", runId);
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "events.jsonl");

    const event1 = makeEvent(runId, 1, "run.created");
    const corruptedMiddle = "CORRUPT_NOT_JSON";
    const event3 = makeEvent(runId, 3, "task.ready", { task_id: "TaskA" });

    writeFileSync(logPath, `${JSON.stringify(event1)}\n${corruptedMiddle}\n${JSON.stringify(event3)}\n`);

    const store = new EventStore(runId, { baseDir });
    await expect(store.readAll()).rejects.toThrow(/corruption|line 2/i);
  });

  it("halts and throws fatal error on middle-line schema violation", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const logDir = join(baseDir, ".substrate", "runs", runId);
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "events.jsonl");

    const event1 = makeEvent(runId, 1, "run.created");
    const badSchemaMiddle = JSON.stringify({ v: 99, seq: 2, bad: true });
    const event3 = makeEvent(runId, 3, "task.ready", { task_id: "TaskA" });

    writeFileSync(logPath, `${JSON.stringify(event1)}\n${badSchemaMiddle}\n${JSON.stringify(event3)}\n`);

    const store = new EventStore(runId, { baseDir });
    await expect(store.readAll()).rejects.toThrow(/corruption|line 2|schema/i);
  });
});

describe("store: EventStore replay", () => {
  it("replays empty log returning initial blank state without crashing", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const store = new EventStore(runId, { baseDir });

    const state = await store.replay();
    expect(state.run_id).toBe(runId);
    expect(state.state).toBe("CREATED");
    expect(state.usage.total_usd).toBe(0);
    expect(Object.keys(state.tasks)).toHaveLength(0);
  });

  it("replays full event log sequentially through reducer to derive final state", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const store = new EventStore(runId, { baseDir });

    await store.append(makeEvent(runId, 1, "run.created", { run_id: runId }));
    await store.append(makeEvent(runId, 2, "run.routed", { mode: "plan" }));
    await store.append(makeEvent(runId, 3, "plan.produced", { tasks: [{ id: "TaskA" }] }));
    await store.append(makeEvent(runId, 4, "plan.approved", {}));
    await store.append(makeEvent(runId, 5, "setup.done", {}));
    await store.append(makeEvent(runId, 6, "task.ready", { task_id: "TaskA" }));

    const state = await store.replay();
    expect(state.run_id).toBe(runId);
    expect(state.state).toBe("EXECUTING");
    expect(state.tasks["TaskA"]).toBeDefined();
    expect(state.tasks["TaskA"].state).toBe("READY");
  });

  it("accepts custom initialState for incremental replay", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const store = new EventStore(runId, { baseDir });

    const initialCustom = {
      run_id: runId,
      state: "SETUP" as const,
      tasks: {},
      usage: { total_usd: 1.5, by_role: { planner: 1.5 } },
      checkpoints: ["cp1"],
    };

    await store.append(makeEvent(runId, 1, "setup.done", {}));

    const state = await store.replay(initialCustom);
    expect(state.state).toBe("EXECUTING");
    expect(state.usage.total_usd).toBe(1.5);
    expect(state.checkpoints).toEqual(["cp1"]);
  });
});
