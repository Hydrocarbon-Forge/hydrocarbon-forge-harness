import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BackendEvent,
  SessionResult,
  UsageRecord,
  type PricingTable,
} from "../../../src/contracts/index.js";
import { parseNdjsonLine } from "../../../src/backends/ndjson.js";
import {
  AgyNormalizer,
  normalizeAgyStream,
  type AgyNormalizerOptions,
  type AgyRawEvent,
} from "../../../src/backends/normalize/agy.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../../fixtures/backends/agy");

const samplePricing: PricingTable = {
  asOf: "2026-10-16",
  sources: ["https://ai.google.dev/gemini-api/docs/pricing"],
  models: {
    "gemini-3.8-flash-low": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
      cache_read_per_mtok: 0.075,
    },
    "gemini-3.8-flash": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
      cache_read_per_mtok: 0.075,
    },
    "gemini-3.8-flash-high": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
    },
  },
};

function readFixtureLines(filename: string): string[] {
  const content = readFileSync(resolve(fixturesDir, filename), "utf8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function readFixtureRawEvents(filename: string): AgyRawEvent[] {
  return readFixtureLines(filename).map((line) =>
    parseNdjsonLine<AgyRawEvent>(line)
  );
}

describe("AgyNormalizer - Golden Tests from S3 Spike Fixtures", () => {
  it("normalizes success.ndjson: emits session.started, assistant.text, usage, and session.result", () => {
    const rawEvents = readFixtureRawEvents("success.ndjson");
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const emitted: BackendEvent[] = [];
    for (const raw of rawEvents) {
      emitted.push(...normalizer.normalizeEvent(raw));
    }
    emitted.push(...normalizer.finalize(0));

    // Validate every event conforms to BackendEvent schema
    for (const event of emitted) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
    }

    // 1. Session started
    const started = emitted.find((e) => e.type === "session.started");
    expect(started).toBeDefined();
    if (started?.type === "session.started") {
      expect(started.session_id).toBe("bd58e925-652b-4856-b3f3-24ff2bfb8cb9");
    }
    expect(normalizer.getConversationId()).toBe(
      "bd58e925-652b-4856-b3f3-24ff2bfb8cb9"
    );

    // 2. Assistant text delta
    const textEvents = emitted.filter((e) => e.type === "assistant.text");
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    const joinedText = textEvents
      .map((e) => (e.type === "assistant.text" ? e.text : ""))
      .join("");
    expect(joinedText).toBe("OK\n");

    // 3. Step usage record with computed cost
    const usageEvents = emitted.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    if (usageEvents[0]?.type === "usage") {
      expect(usageEvents[0].record.cost_source).toBe("computed");
      expect(usageEvents[0].record.backend).toBe("agy");
      expect(usageEvents[0].record.model).toBe("gemini-3.8-flash-low");
      expect(usageEvents[0].record.input_tokens).toBe(11827);
      expect(usageEvents[0].record.output_tokens).toBe(13);
      expect(usageEvents[0].record.cost_usd).toBeGreaterThan(0);
      expect(usageEvents[0].cumulative).toBe(false);
    }

    // 4. Session result
    const resultEvent = emitted.find((e) => e.type === "session.result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === "session.result") {
      expect(resultEvent.ok).toBe(true);
      expect(resultEvent.exit_code).toBe(0);
      expect(resultEvent.final_text).toBe("OK\n");
      expect(resultEvent.usage?.cost_source).toBe("computed");
      expect(resultEvent.usage?.input_tokens).toBe(11827);
      expect(resultEvent.usage?.output_tokens).toBe(13);
    }

    expect(normalizer.getDenials()).toEqual([]);
  });

  it("normalizes denial.ndjson & denial.stderr.txt: detects soft-deny, marks ok=false despite exit 0", () => {
    const rawEvents = readFixtureRawEvents("denial.ndjson");
    const stderrText = readFileSync(
      resolve(fixturesDir, "denial.stderr.txt"),
      "utf8"
    );

    const onDenial = vi.fn();
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
      onDenial,
    });

    const emitted: BackendEvent[] = [];

    // Process stream events
    for (const raw of rawEvents) {
      emitted.push(...normalizer.normalizeEvent(raw));
    }

    // Process stderr chunk containing jetski auto-deny note
    emitted.push(...normalizer.scanStderr(stderrText));

    // Exit code is 0 (spike confirmed agy exits 0 on auto-denied tools)
    emitted.push(...normalizer.finalize(0));

    for (const event of emitted) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
    }

    // Tool call and result events
    const toolCall = emitted.find((e) => e.type === "tool.call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool.call") {
      expect(toolCall.name).toBe("run_command");
      expect(toolCall.input_summary).toContain("touch");
    }

    const toolResult = emitted.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool.result") {
      expect(toolResult.ok).toBe(true);
    }

    // Permission denied event emitted from denied_actions and/or stderr
    const denialEvents = emitted.filter((e) => e.type === "permission.denied");
    expect(denialEvents.length).toBeGreaterThanOrEqual(1);

    // Invariant I11: Never treat exit code 0 alone as success!
    const resultEvent = emitted.find((e) => e.type === "session.result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === "session.result") {
      expect(resultEvent.ok).toBe(false); // soft-denial must fail!
      expect(resultEvent.exit_code).toBe(0);
      expect(resultEvent.final_text).toBe(""); // empty response preserved
    }

    const denials = normalizer.getDenials();
    expect(denials.length).toBeGreaterThan(0);
    expect(
      denials.some(
        (d) => d.tool === "RunCommand" || d.tool === "command" || d.reason === "command"
      )
    ).toBe(true);
    expect(onDenial).toHaveBeenCalled();
  });

  it("normalizes effort-error.ndjson & effort-error.stderr.txt: translates status ERROR to error and failed result", () => {
    const rawEvents = readFixtureRawEvents("effort-error.ndjson");
    const stderrText = readFileSync(
      resolve(fixturesDir, "effort-error.stderr.txt"),
      "utf8"
    );

    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const emitted: BackendEvent[] = [];
    for (const raw of rawEvents) {
      emitted.push(...normalizer.normalizeEvent(raw));
    }
    emitted.push(...normalizer.scanStderr(stderrText));
    emitted.push(...normalizer.finalize(1));

    for (const event of emitted) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
    }

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.kind).toBe("crash");
      expect(errorEvent.message).toContain("conflicts with --effort=max");
    }

    const resultEvent = emitted.find((e) => e.type === "session.result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === "session.result") {
      expect(resultEvent.ok).toBe(false);
      expect(resultEvent.exit_code).toBe(1);
    }
  });

  it("normalizes session-create.ndjson and session-resume.ndjson across multi-turn session", () => {
    // Turn 1: create
    const createEvents = readFixtureRawEvents("session-create.ndjson");
    const normCreate = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const emitted1: BackendEvent[] = [];
    for (const raw of createEvents) {
      emitted1.push(...normCreate.normalizeEvent(raw));
    }
    emitted1.push(...normCreate.finalize(0));

    const convId1 = normCreate.getConversationId();
    expect(convId1).toBe("57faeed3-67d8-4487-ab3e-bd3021af5181");

    // Turn 2: resume
    const resumeEvents = readFixtureRawEvents("session-resume.ndjson");
    const normResume = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const emitted2: BackendEvent[] = [];
    for (const raw of resumeEvents) {
      emitted2.push(...normResume.normalizeEvent(raw));
    }
    emitted2.push(...normResume.finalize(0));

    const convId2 = normResume.getConversationId();
    expect(convId2).toBe("57faeed3-67d8-4487-ab3e-bd3021af5181");

    const result2 = emitted2.find((e) => e.type === "session.result");
    expect(result2).toBeDefined();
    if (result2?.type === "session.result") {
      expect(result2.ok).toBe(true);
      expect(result2.final_text).toContain("BRAVO-42");
      // R2.5: the session total is the sum of this session's step records, not the
      // result event's conversation-cumulative usage (23884 would double-count turn 1).
      expect(result2.usage?.input_tokens).toBe(12049);
      expect(result2.usage?.output_tokens).toBe(5);
      expect(result2.usage?.cost_source).toBe("computed");
      // 12049 * 0.75 / 1e6 + 5 * 3.75 / 1e6
      expect(result2.usage?.cost_usd).toBeCloseTo(0.0090555, 10);
    }

    // Invariant: the usage events of the run equal the session total.
    const usageEvents2 = emitted2.filter((e) => e.type === "usage");
    expect(usageEvents2.length).toBe(1);
    const summedInput = usageEvents2.reduce(
      (sum, e) => (e.type === "usage" ? sum + e.record.input_tokens : sum),
      0
    );
    const summedCost = usageEvents2.reduce(
      (sum, e) => (e.type === "usage" ? sum + e.record.cost_usd : sum),
      0
    );
    const resultEvent2 = emitted2.find((e) => e.type === "session.result");
    if (resultEvent2?.type === "session.result") {
      expect(resultEvent2.usage?.input_tokens).toBe(summedInput);
      expect(resultEvent2.usage?.cost_usd).toBeCloseTo(summedCost, 10);
    }
  });

  it("normalizes sandbox.ndjson: detects denial under sandbox mode", () => {
    const rawEvents = readFixtureRawEvents("sandbox.ndjson");
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const emitted: BackendEvent[] = [];
    for (const raw of rawEvents) {
      emitted.push(...normalizer.normalizeEvent(raw));
    }
    emitted.push(...normalizer.finalize(0));

    const result = emitted.find((e) => e.type === "session.result");
    expect(result).toBeDefined();
    if (result?.type === "session.result") {
      expect(result.ok).toBe(false); // sandbox still denied, exit 0
      expect(result.usage?.input_tokens).toBeGreaterThan(12000);
    }
    expect(normalizer.getDenials().length).toBeGreaterThan(0);
  });
});

describe("AgyNormalizer - Invariants and Edge Cases", () => {
  it("enforces Cost Source Invariant: all UsageRecords have cost_source: 'computed'", () => {
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const events = normalizer.normalizeEvent({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        usage: { input_tokens: 1000, output_tokens: 50 },
      },
    });

    const usageEvt = events.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    if (usageEvt?.type === "usage") {
      expect(usageEvt.record.cost_source).toBe("computed");
      expect(UsageRecord.safeParse(usageEvt.record).success).toBe(true);
    }

    const finalEvents = normalizer.normalizeEvent({
      event: "result",
      result: {
        conversation_id: "conv-1",
        status: "SUCCESS",
        response: "done",
        usage: { input_tokens: 1000, output_tokens: 50 },
      },
    });
    const finalResult = finalEvents.find((e) => e.type === "session.result");
    if (finalResult?.type === "session.result") {
      expect(finalResult.usage?.cost_source).toBe("computed");
    }
  });

  it("yields usage event with cost_source 'unknown' and stream continues to session.result when model is unlisted in PricingTable", () => {
    const normalizer = new AgyNormalizer({
      model: "unlisted-model-xyz",
      pricing: samplePricing,
    });
    const events: BackendEvent[] = [];
    events.push(
      ...normalizer.normalizeEvent({
        event: "init",
        conversation_id: "c1",
        init: { model: "unlisted-model-xyz" },
      }),
    );
    events.push(
      ...normalizer.normalizeEvent({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "DONE",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
    );
    events.push(
      ...normalizer.normalizeEvent({
        event: "result",
        result: {
          conversation_id: "c1",
          status: "SUCCESS",
          response: "ok",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
    );
    events.push(...normalizer.finalize(0));

    const usageEvt = events.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    if (usageEvt?.type === "usage") {
      expect(usageEvt.record.cost_source).toBe("unknown");
      expect(usageEvt.record.cost_usd).toBe(0);
      expect(usageEvt.record.model).toBe("unlisted-model-xyz");
    }

    const resultEvt = events.find((e) => e.type === "session.result");
    expect(resultEvt).toBeDefined();
    if (resultEvt?.type === "session.result") {
      expect(resultEvt.ok).toBe(true);
      expect(resultEvt.usage?.cost_source).toBe("unknown");
      expect(resultEvt.usage?.cost_usd).toBe(0);
    }
  });

  it("emits error with kind protocol and the step number when a step record cannot be built, and the stream continues", () => {
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const events: BackendEvent[] = [];
    events.push(
      ...normalizer.normalizeEvent({
        event: "step_update",
        step_update: {
          step_index: 3,
          step_type: "agent_response",
          state: "DONE",
          usage: { input_tokens: Number.NaN, output_tokens: 10 },
        },
      })
    );

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.kind).toBe("protocol");
      expect(err.message).toContain("step 3");
    }

    // The swallow is gone: the stream is not cut short by the bad record.
    events.push(
      ...normalizer.normalizeEvent({
        event: "result",
        result: {
          conversation_id: "c1",
          status: "SUCCESS",
          response: "ok",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      })
    );

    const resultEvt = events.find((e) => e.type === "session.result");
    expect(resultEvt).toBeDefined();
    if (resultEvt?.type === "session.result") {
      expect(resultEvt.ok).toBe(true);
      // The failed step contributes nothing to the total.
      expect(resultEvt.usage?.input_tokens).toBe(0);
    }
  });

  it("does not emit the result event's usage as a usage event, so the total is the sum of step records", () => {
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const events: BackendEvent[] = [];
    events.push(
      ...normalizer.normalizeEvent({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "DONE",
          usage: { input_tokens: 200, output_tokens: 20 },
        },
      })
    );
    events.push(
      ...normalizer.normalizeEvent({
        event: "result",
        result: {
          conversation_id: "c1",
          status: "SUCCESS",
          response: "ok",
          // Conversation-cumulative usage; must not become a usage event or the total.
          usage: { input_tokens: 9000, output_tokens: 90 },
        },
      })
    );

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBe(1);
    if (usageEvents[0]?.type === "usage") {
      expect(usageEvents[0].record.input_tokens).toBe(200);
    }

    const resultEvt = events.find((e) => e.type === "session.result");
    if (resultEvt?.type === "session.result") {
      expect(resultEvt.usage?.input_tokens).toBe(200);
    }
  });

  it("maps rate limit error message to error kind 'rate_limit'", () => {
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const events = normalizer.normalizeEvent({
      event: "result",
      result: {
        conversation_id: "c1",
        status: "ERROR",
        response: "",
        error: "Rate limit exceeded (429): Resource exhausted",
      },
    });

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.kind).toBe("rate_limit");
    }
  });

  it("maps auth failure message to error kind 'auth'", () => {
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const events = normalizer.normalizeEvent({
      event: "result",
      result: {
        conversation_id: "c1",
        status: "ERROR",
        response: "",
        error: "401 Unauthorized: Invalid API key provided",
      },
    });

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.kind).toBe("auth");
    }
  });

  it("deduplicates denial signals between stderr jetski notice and result denied_actions", () => {
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    normalizer.scanStderr(
      'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.'
    );

    normalizer.normalizeEvent({
      event: "result",
      result: {
        conversation_id: "c1",
        status: "SUCCESS",
        response: "",
        denied_actions: [{ action: "command", display_name: "RunCommand" }],
      },
    });

    const denials = normalizer.getDenials();
    // Should be deduplicated into a single logical denial
    expect(denials.length).toBe(1);
    expect(denials[0].tool).toBe("RunCommand");
  });

  it("surfaces subagent event when step_update contains subagent_info", () => {
    const normalizer = new AgyNormalizer({
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const subagentPayload = { id: "sub-1", role: "search", status: "launched" };
    const events = normalizer.normalizeEvent({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        subagent_info: subagentPayload,
      },
    });

    const subagentEvt = events.find((e) => e.type === "subagent");
    expect(subagentEvt).toBeDefined();
    if (subagentEvt?.type === "subagent") {
      expect(subagentEvt.raw).toEqual(subagentPayload);
    }
  });

  it("normalizeAgyStream consumes async streams and yields ordered BackendEvent sequence", async () => {
    async function* makeEvents(): AsyncIterable<AgyRawEvent> {
      yield {
        event: "init",
        conversation_id: "stream-conv-1",
        init: { model: "gemini-3.8-flash-low" },
      };
      yield {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "Streaming hello",
        },
      };
      yield {
        event: "result",
        result: {
          conversation_id: "stream-conv-1",
          status: "SUCCESS",
          response: "Streaming hello",
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      };
    }

    async function* makeStderr(): AsyncIterable<string> {
      // Empty stderr stream
    }

    const events: BackendEvent[] = [];
    for await (const event of normalizeAgyStream(makeEvents(), makeStderr(), {
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    })) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe("session.started");
    expect(events[events.length - 1].type).toBe("session.result");
  });
});
