import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";

export interface StreamResultEvent {
  type: "result";
  subtype: "success" | "error_failed" | "error_budget" | "error_needs_human";
  is_error: boolean;
  session_id: string;
  run_id: Contracts.RunId;
  num_tasks: number;
  total_cost_usd: number;
  usage: { by_role: Record<string, number> };
  duration_ms: number;
}

export interface OutputFormatter {
  onEvent(event: Contracts.EngineEvent): void;
  onSummary(summary: Contracts.RunSummary, sessionId: string): void;
  onError(error: Error | string): void;
  flush(): Promise<void>;
}

export type CreateFormatterFn = (
  format: "text" | "json" | "stream-json",
  out: NodeJS.WriteStream,
) => OutputFormatter;

async function loadOutputModule(): Promise<{
  createFormatter: CreateFormatterFn;
}> {
  return (await import("../../../src/cli/output.js" as any)) as any;
}

function createMockStream(): NodeJS.WriteStream & {
  getOutput: () => string;
  getLines: () => string[];
} {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as any;
  stream.isTTY = false;
  stream.getOutput = () => output;
  stream.getLines = () => output.trim().split("\n").filter((l) => l.trim().length > 0);
  return stream;
}

function makeEngineEvent(
  run_id: Contracts.RunId,
  seq: number,
  type: string,
  data: unknown = {},
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

function makeSampleSummary(run_id: Contracts.RunId): Contracts.RunSummary {
  return Contracts.RunSummary.parse({
    run_id,
    status: "finished",
    tasks: {
      T1: { state: "verified", generation: 1 },
      T2: { state: "verified", generation: 1 },
    },
    usage: {
      total_usd: 0.42,
      by_role: { planner: 0.12, worker: 0.30 },
    },
    branch: `substrate/runs/${run_id}`,
    exit_code: 0,
  });
}

describe("cli: output formatters (text, json, stream-json)", () => {
  describe("text format", () => {
    it("prints human-readable summary table on onSummary", async () => {
      const { createFormatter } = await loadOutputModule();
      const stream = createMockStream();
      const formatter = createFormatter("text", stream);

      const runId = createRunId() as Contracts.RunId;
      const summary = makeSampleSummary(runId);

      formatter.onEvent(makeEngineEvent(runId, 1, "task.started", { task_id: "T1" }));
      formatter.onSummary(summary, "sess_text_test");
      await formatter.flush();

      const output = stream.getOutput();
      // Verifies human summary contents per §4.6
      expect(output).toContain(runId);
      expect(output).toMatch(/finished/i);
      expect(output).toContain("0.42");
      expect(output).toContain(`substrate/runs/${runId}`);
    });

    it("formats errors clearly on onError", async () => {
      const { createFormatter } = await loadOutputModule();
      const stream = createMockStream();
      const formatter = createFormatter("text", stream);

      formatter.onError(new Error("Fatal harness defect"));
      await formatter.flush();

      const output = stream.getOutput();
      expect(output).toMatch(/Error.*Fatal harness defect/i);
    });
  });

  describe("json format", () => {
    it("buffers events and outputs a single valid JSON object on onSummary", async () => {
      const { createFormatter } = await loadOutputModule();
      const stream = createMockStream();
      const formatter = createFormatter("json", stream);

      const runId = createRunId() as Contracts.RunId;
      const summary = makeSampleSummary(runId);

      formatter.onEvent(makeEngineEvent(runId, 1, "run.created", { run_id: runId }));
      formatter.onSummary(summary, "sess_json_123");
      await formatter.flush();

      const output = stream.getOutput().trim();
      const parsed = JSON.parse(output);

      expect(parsed).toBeDefined();
      expect(parsed.run_id).toBe(runId);
      expect(parsed.session_id).toBe("sess_json_123");
      expect(parsed.status).toBe("finished");
      expect(parsed.exit_code).toBe(0);
      expect(parsed.usage.total_usd).toBe(0.42);
      expect(parsed.tasks.T1.state).toBe("verified");
    });
  });

  describe("stream-json format (NDJSON & Claude Code result event)", () => {
    it("streams events as single-line NDJSON and translates engine event types", async () => {
      const { createFormatter } = await loadOutputModule();
      const stream = createMockStream();
      const formatter = createFormatter("stream-json", stream);

      const runId = createRunId() as Contracts.RunId;

      // Send standard progression of events
      formatter.onEvent(makeEngineEvent(runId, 1, "system.init", { session_id: "sess_stream", run_id: runId }));
      formatter.onEvent(makeEngineEvent(runId, 2, "run.state", { state: "running", ts: nowIsoTimestamp() }));
      formatter.onEvent(makeEngineEvent(runId, 3, "plan.ready", { task_count: 2 }));
      formatter.onEvent(makeEngineEvent(runId, 4, "task.started", { task_id: "T1", title: "Task 1" }));
      formatter.onEvent(makeEngineEvent(runId, 5, "task.verified", { task_id: "T1", verdict: "pass" }));
      formatter.onEvent(makeEngineEvent(runId, 6, "batch.merged", { batch_id: "b1", task_ids: ["T1"] }));

      await formatter.flush();

      const lines = stream.getLines();
      expect(lines.length).toBeGreaterThanOrEqual(6);

      // Verify every line is valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // Verify protocol event types
      const parsedEvents = lines.map((l) => JSON.parse(l));
      const types = parsedEvents.map((e) => e.type);
      expect(types).toContain("system.init");
      expect(types).toContain("run.state");
      expect(types).toContain("plan.ready");
      expect(types).toContain("task.started");
      expect(types).toContain("task.verified");
      expect(types).toContain("batch.merged");
    });

    it("terminates with standard Claude Code-style result event schema on successful run", async () => {
      const { createFormatter } = await loadOutputModule();
      const stream = createMockStream();
      const formatter = createFormatter("stream-json", stream);

      const runId = createRunId() as Contracts.RunId;
      const summary = makeSampleSummary(runId);

      formatter.onSummary(summary, "sess_stream_success");
      await formatter.flush();

      const lines = stream.getLines();
      expect(lines.length).toBeGreaterThan(0);
      const lastEvent = JSON.parse(lines[lines.length - 1]) as StreamResultEvent;

      // Validate StreamResultEvent schema per §4.6
      expect(lastEvent.type).toBe("result");
      expect(lastEvent.subtype).toBe("success");
      expect(lastEvent.is_error).toBe(false);
      expect(lastEvent.session_id).toBe("sess_stream_success");
      expect(lastEvent.run_id).toBe(runId);
      expect(lastEvent.num_tasks).toBe(2);
      expect(lastEvent.total_cost_usd).toBe(0.42);
      expect(typeof lastEvent.usage.by_role).toBe("object");
      expect(lastEvent.usage.by_role.worker).toBe(0.30);
      expect(typeof lastEvent.duration_ms).toBe("number");
    });

    it("maps failure, budget, and pause states to corresponding result event subtypes", async () => {
      const { createFormatter } = await loadOutputModule();

      // Case 1: Failed run
      {
        const stream = createMockStream();
        const formatter = createFormatter("stream-json", stream);
        const runId = createRunId() as Contracts.RunId;
        const failedSummary: Contracts.RunSummary = {
          run_id: runId,
          status: "failed",
          tasks: { T1: { state: "failed", generation: 1, failure_class: "verify_failed" } },
          usage: { total_usd: 0.1, by_role: {} },
          branch: `substrate/runs/${runId}`,
          exit_code: 1,
        };
        formatter.onSummary(failedSummary, "sess_failed");
        await formatter.flush();

        const lastEvent = JSON.parse(stream.getLines().pop()!) as StreamResultEvent;
        expect(lastEvent.type).toBe("result");
        expect(lastEvent.subtype).toBe("error_failed");
        expect(lastEvent.is_error).toBe(true);
      }

      // Case 2: Budget exhausted
      {
        const stream = createMockStream();
        const formatter = createFormatter("stream-json", stream);
        const runId = createRunId() as Contracts.RunId;
        const budgetSummary: Contracts.RunSummary = {
          run_id: runId,
          status: "paused",
          pause_reason: "budget_exhausted",
          tasks: {},
          usage: { total_usd: 5.01, by_role: {} },
          branch: `substrate/runs/${runId}`,
          exit_code: 4,
        };
        formatter.onSummary(budgetSummary, "sess_budget");
        await formatter.flush();

        const lastEvent = JSON.parse(stream.getLines().pop()!) as StreamResultEvent;
        expect(lastEvent.type).toBe("result");
        expect(lastEvent.subtype).toBe("error_budget");
        expect(lastEvent.is_error).toBe(true);
      }

      // Case 3: Needs human / approval pause
      {
        const stream = createMockStream();
        const formatter = createFormatter("stream-json", stream);
        const runId = createRunId() as Contracts.RunId;
        const humanSummary: Contracts.RunSummary = {
          run_id: runId,
          status: "paused",
          pause_reason: "needs_human",
          tasks: {},
          usage: { total_usd: 0.05, by_role: {} },
          branch: `substrate/runs/${runId}`,
          exit_code: 3,
        };
        formatter.onSummary(humanSummary, "sess_human");
        await formatter.flush();

        const lastEvent = JSON.parse(stream.getLines().pop()!) as StreamResultEvent;
        expect(lastEvent.type).toBe("result");
        expect(lastEvent.subtype).toBe("error_needs_human");
        expect(lastEvent.is_error).toBe(true);
      }
    });
  });
});
