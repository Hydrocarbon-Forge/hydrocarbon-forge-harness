import { describe, it, expect } from "vitest";
import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BackendEvent,
  PricingTable,
  SessionId,
  type UsageRecord,
} from "../../../src/contracts/index.js";
import { readNdjsonStream } from "../../../src/backends/ndjson.js";
import {
  normalizeOpenCodeStream,
  parseOpenCodeEvent,
  type OpenCodeNormalizeOptions,
  type OpenCodeRawEvent,
} from "../../../src/backends/normalize/opencode.js";

const FIXTURES_DIR = resolve(
  __dirname,
  "../../fixtures/backends/opencode"
);

function readFixtureStream(fileName: string): AsyncIterable<unknown> {
  const filePath = resolve(FIXTURES_DIR, fileName);
  const nodeStream = createReadStream(filePath);
  return readNdjsonStream(nodeStream);
}

const SAMPLE_PRICING: PricingTable = PricingTable.parse({
  asOf: "2026-10-16",
  sources: ["https://example.com/pricing"],
  models: {
    "opencode/deepseek-v4.1-flash-free": {
      input_per_mtok: 0.14,
      output_per_mtok: 0.28,
      cache_read_per_mtok: 0.014,
      cache_write_per_mtok: 0.028,
    },
    "opencode/custom-model": {
      input_per_mtok: 1.0,
      output_per_mtok: 2.0,
    },
  },
});

describe("OpenCode Normalizer: Golden Fixtures (S2 Spike)", () => {
  it("normalizes success.ndjson: handles missing step_finish gracefully and yields fallback usage", async () => {
    const rawStream = readFixtureStream("success.ndjson");
    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawStream, options)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    // Must yield session.started, assistant.text, and session.result
    expect(events.length).toBeGreaterThanOrEqual(3);

    // 1. session.started
    expect(events[0].type).toBe("session.started");
    if (events[0].type === "session.started") {
      expect(events[0].session_id).toBe("ses_eba239c7bffeAUsAMAowIHtR03");
    }

    // 2. assistant.text
    const textEvent = events.find((e) => e.type === "assistant.text");
    expect(textEvent).toBeDefined();
    if (textEvent && textEvent.type === "assistant.text") {
      expect(textEvent.text).toBe("OK");
    }

    // 3. session.result (with synthesized fallback usage because step_finish was omitted on stdout)
    const resultEvent = events[events.length - 1];
    expect(resultEvent.type).toBe("session.result");
    if (resultEvent.type === "session.result") {
      expect(resultEvent.ok).toBe(true);
      expect(resultEvent.final_text).toBe("OK");
      expect(resultEvent.usage).toBeDefined();
      expect(resultEvent.usage?.backend).toBe("opencode");
      expect(resultEvent.usage?.model).toBe("opencode/deepseek-v4.1-flash-free");
      expect(resultEvent.usage?.cost_usd).toBe(0);
    }
  });

  it("normalizes tool-call.ndjson: parses tool call, result, step_finish usage, and final text", async () => {
    const rawStream = readFixtureStream("tool-call.ndjson");
    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawStream, options)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    // Check session.started
    expect(events[0].type).toBe("session.started");
    if (events[0].type === "session.started") {
      expect(events[0].session_id).toBe("ses_eba23c36fffemkr0mz7FRxVlH6");
    }

    // Check tool.call
    const toolCall = events.find((e) => e.type === "tool.call");
    expect(toolCall).toBeDefined();
    if (toolCall && toolCall.type === "tool.call") {
      expect(toolCall.id).toBe("call_00_wg55m1todwjv3n945imhikft");
      expect(toolCall.name).toBe("shell");
      expect(toolCall.input_summary).toContain("echo TOOL_OK_123");
    }

    // Check tool.result
    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === "tool.result") {
      expect(toolResult.id).toBe("call_00_wg55m1todwjv3n945imhikft");
      expect(toolResult.ok).toBe(true);
      expect(toolResult.output_summary).toContain("TOOL_OK_123");
    }

    // Check usage event from step_finish
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent && usageEvent.type === "usage") {
      expect(usageEvent.record.backend).toBe("opencode");
      expect(usageEvent.record.input_tokens).toBe(3430);
      expect(usageEvent.record.output_tokens).toBe(42);
      expect(usageEvent.record.reasoning_tokens).toBe(144);
      expect(usageEvent.record.cache_read_tokens).toBe(4096);
      expect(usageEvent.record.cache_write_tokens).toBe(0);
      expect(usageEvent.record.cost_usd).toBe(0);
      expect(usageEvent.record.cost_source).toBe("reported");
    }

    // Check assistant.text
    const textEvent = events.find((e) => e.type === "assistant.text");
    expect(textEvent).toBeDefined();
    if (textEvent && textEvent.type === "assistant.text") {
      expect(textEvent.text).toContain("TOOL_OK_123");
    }

    // Check session.result
    const resultEvent = events[events.length - 1];
    expect(resultEvent.type).toBe("session.result");
    if (resultEvent.type === "session.result") {
      expect(resultEvent.ok).toBe(true);
      expect(resultEvent.final_text).toContain("TOOL_OK_123");
      expect(resultEvent.usage?.input_tokens).toBe(3430);
      expect(resultEvent.usage?.output_tokens).toBe(42);
    }
  });

  it("normalizes denial.ndjson: detects model refusal and yields permission.denied event", async () => {
    const rawStream = readFixtureStream("denial.ndjson");
    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawStream, options)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    // Expect session.started
    expect(events[0].type).toBe("session.started");

    // Expect permission.denied detected from model refusal text
    const denialEvent = events.find((e) => e.type === "permission.denied");
    expect(denialEvent).toBeDefined();
    if (denialEvent && denialEvent.type === "permission.denied") {
      expect(denialEvent.tool.toLowerCase()).toContain("shell");
      expect(denialEvent.reason).toContain("no shell/bash tool is available");
    }

    // Expect assistant.text
    const textEvent = events.find((e) => e.type === "assistant.text");
    expect(textEvent).toBeDefined();

    // Expect session.result
    const resultEvent = events[events.length - 1];
    expect(resultEvent.type).toBe("session.result");
    if (resultEvent.type === "session.result") {
      expect(resultEvent.ok).toBe(true);
      expect(resultEvent.final_text).toContain("no shell/bash tool is available");
    }
  });

  it("normalizes resume.ndjson: maintains session identity and emits final text", async () => {
    const rawStream = readFixtureStream("resume.ndjson");
    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawStream, options)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    expect(events[0].type).toBe("session.started");
    if (events[0].type === "session.started") {
      expect(events[0].session_id).toBe("ses_eba23c36fffemkr0mz7FRxVlH6");
    }

    const textEvent = events.find((e) => e.type === "assistant.text");
    expect(textEvent).toBeDefined();
    if (textEvent && textEvent.type === "assistant.text") {
      expect(textEvent.text).toContain("TOOL_OK_123");
    }

    const resultEvent = events[events.length - 1];
    expect(resultEvent.type).toBe("session.result");
    if (resultEvent.type === "session.result") {
      expect(resultEvent.ok).toBe(true);
      expect(resultEvent.final_text).toContain("TOOL_OK_123");
    }
  });

  it("normalizes error-badmodel.ndjson: maps provider.no-route to crash error and ok: false", async () => {
    const rawStream = readFixtureStream("error-badmodel.ndjson");
    const options: OpenCodeNormalizeOptions = {
      model: "opencode/no-such-model-xyz",
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawStream, options)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    // Must emit session.started even on error
    expect(events[0].type).toBe("session.started");

    // Must emit error with kind: "crash"
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.kind).toBe("crash");
      expect(errorEvent.message).toContain("Model unavailable");
    }

    // Result must have ok: false
    const resultEvent = events[events.length - 1];
    expect(resultEvent.type).toBe("session.result");
    if (resultEvent.type === "session.result") {
      expect(resultEvent.ok).toBe(false);
    }
  });
});

describe("OpenCode Normalizer: parseOpenCodeEvent unit tests", () => {
  const options: OpenCodeNormalizeOptions = {
    model: "opencode/deepseek-v4.1-flash-free",
  };

  it("parses step_start event", () => {
    const raw = {
      type: "step_start",
      sessionID: "ses_123",
      part: { id: "prt_1", type: "step-start" },
    };
    const events = parseOpenCodeEvent(raw, options);
    // Should yield session.started on initial event
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("session.started");
  });

  it("parses text event into assistant.text", () => {
    const raw = {
      type: "text",
      sessionID: "ses_123",
      part: { id: "prt_2", type: "text", text: "Hello from OpenCode" },
    };
    const events = parseOpenCodeEvent(raw, options);
    const textEvent = events.find((e) => e.type === "assistant.text");
    expect(textEvent).toBeDefined();
    if (textEvent && textEvent.type === "assistant.text") {
      expect(textEvent.text).toBe("Hello from OpenCode");
    }
  });

  it("parses model refusal text into permission.denied and assistant.text", () => {
    const raw = {
      type: "text",
      sessionID: "ses_123",
      part: {
        id: "prt_3",
        type: "text",
        text: "I cannot execute this because no shell/bash tool is available in this session.",
      },
    };
    const events = parseOpenCodeEvent(raw, options);
    const denial = events.find((e) => e.type === "permission.denied");
    expect(denial).toBeDefined();
    if (denial && denial.type === "permission.denied") {
      expect(denial.tool.toLowerCase()).toContain("shell");
      expect(denial.reason).toContain("no shell/bash tool is available");
    }
    const text = events.find((e) => e.type === "assistant.text");
    expect(text).toBeDefined();
  });

  it("parses tool_use event into tool.call and tool.result", () => {
    const raw = {
      type: "tool_use",
      sessionID: "ses_123",
      part: {
        type: "tool",
        id: "call_abc",
        tool: "edit",
        state: {
          status: "completed",
          input: { path: "src/foo.ts", content: "export const x = 1;" },
          output: "File updated",
          metadata: { exit: 0 },
        },
      },
    };
    const events = parseOpenCodeEvent(raw, options);
    const call = events.find((e) => e.type === "tool.call");
    expect(call).toBeDefined();
    if (call && call.type === "tool.call") {
      expect(call.id).toBe("call_abc");
      expect(call.name).toBe("edit");
      expect(call.input_summary).toContain("src/foo.ts");
    }

    const res = events.find((e) => e.type === "tool.result");
    expect(res).toBeDefined();
    if (res && res.type === "tool.result") {
      expect(res.id).toBe("call_abc");
      expect(res.ok).toBe(true);
      expect(res.output_summary).toBe("File updated");
    }
  });

  it("parses step_finish into usage event", () => {
    const raw = {
      type: "step_finish",
      sessionID: "ses_123",
      part: {
        type: "step-finish",
        cost: 0.005,
        tokens: {
          input: 500,
          output: 100,
          reasoning: 50,
          cache: { read: 200, write: 0 },
        },
      },
    };
    const events = parseOpenCodeEvent(raw, options);
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage && usage.type === "usage") {
      expect(usage.record.input_tokens).toBe(500);
      expect(usage.record.output_tokens).toBe(100);
      expect(usage.record.reasoning_tokens).toBe(50);
      expect(usage.record.cache_read_tokens).toBe(200);
      expect(usage.record.cost_usd).toBe(0.005);
      expect(usage.record.cost_source).toBe("reported");
    }
  });

  it("parses error events with different categories", () => {
    // 1. auth error
    const authRaw = {
      type: "error",
      error: { type: "provider.auth", message: "403 Forbidden" },
    };
    const authEvents = parseOpenCodeEvent(authRaw, options);
    const authErr = authEvents.find((e) => e.type === "error");
    expect(authErr).toBeDefined();
    if (authErr && authErr.type === "error") {
      expect(authErr.kind).toBe("auth");
    }

    // 2. rate limit error
    const rateLimitRaw = {
      type: "error",
      error: { type: "provider.rate-limit", message: "Too many requests" },
    };
    const rateLimitEvents = parseOpenCodeEvent(rateLimitRaw, options);
    const rateLimitErr = rateLimitEvents.find((e) => e.type === "error");
    expect(rateLimitErr).toBeDefined();
    if (rateLimitErr && rateLimitErr.type === "error") {
      expect(rateLimitErr.kind).toBe("rate_limit");
    }

    // 3. crash error (no route)
    const crashRaw = {
      type: "error",
      error: { type: "provider.no-route", message: "Model unavailable" },
    };
    const crashEvents = parseOpenCodeEvent(crashRaw, options);
    const crashErr = crashEvents.find((e) => e.type === "error");
    expect(crashErr).toBeDefined();
    if (crashErr && crashErr.type === "error") {
      expect(crashErr.kind).toBe("crash");
    }

    // 4. generic protocol error
    const protocolRaw = {
      type: "error",
      error: { type: "unknown", message: "Something went wrong" },
    };
    const protocolEvents = parseOpenCodeEvent(protocolRaw, options);
    const protocolErr = protocolEvents.find((e) => e.type === "error");
    expect(protocolErr).toBeDefined();
    if (protocolErr && protocolErr.type === "error") {
      expect(protocolErr.kind).toBe("protocol");
    }
  });
});

describe("OpenCode Normalizer: Invariants and Edge Cases", () => {
  it("uses fallbackSessionId when raw events have no sessionID", async () => {
    async function* rawGenerator() {
      yield { type: "step_start", part: { type: "step-start" } };
      yield { type: "text", part: { type: "text", text: "done" } };
    }

    const fallbackId = "ses_fallback_999";
    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
      fallbackSessionId: fallbackId,
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawGenerator(), options)) {
      events.push(event);
    }

    expect(events[0].type).toBe("session.started");
    if (events[0].type === "session.started") {
      expect(events[0].session_id).toBe(fallbackId);
    }
  });

  it("accumulates tokens and cost across multiple step_finish events", async () => {
    async function* rawGenerator() {
      yield {
        type: "step_start",
        sessionID: "ses_multi",
        part: { type: "step-start" },
      };
      yield {
        type: "step_finish",
        sessionID: "ses_multi",
        part: {
          type: "step-finish",
          cost: 0.001,
          tokens: { input: 100, output: 20 },
        },
      };
      yield {
        type: "step_start",
        sessionID: "ses_multi",
        part: { type: "step-start" },
      };
      yield {
        type: "text",
        sessionID: "ses_multi",
        part: { type: "text", text: "second step text" },
      };
      yield {
        type: "step_finish",
        sessionID: "ses_multi",
        part: {
          type: "step-finish",
          cost: 0.002,
          tokens: { input: 200, output: 40 },
        },
      };
    }

    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawGenerator(), options)) {
      events.push(event);
    }

    const result = events[events.length - 1];
    expect(result.type).toBe("session.result");
    if (result.type === "session.result") {
      expect(result.ok).toBe(true);
      expect(result.final_text).toBe("second step text");
      expect(result.usage?.input_tokens).toBe(300);
      expect(result.usage?.output_tokens).toBe(60);
      expect(result.usage?.cost_usd).toBeCloseTo(0.003, 5);
    }
  });

  it("computes cost using pricingTable when step_finish reports cost 0 but pricingTable is given", async () => {
    async function* rawGenerator() {
      yield {
        type: "step_start",
        sessionID: "ses_pricing",
        part: { type: "step-start" },
      };
      yield {
        type: "step_finish",
        sessionID: "ses_pricing",
        part: {
          type: "step-finish",
          cost: 0,
          tokens: { input: 1000, output: 500, cache: { read: 200, write: 0 } },
        },
      };
    }

    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
      pricingTable: SAMPLE_PRICING,
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawGenerator(), options)) {
      events.push(event);
    }

    const result = events[events.length - 1];
    expect(result.type).toBe("session.result");
    if (result.type === "session.result") {
      expect(result.usage?.cost_usd).toBeGreaterThan(0);
      expect(result.usage?.cost_source).toBe("computed");
    }
  });

  it("yields cost_source 'unknown' and cost 0 when step_finish reports cost 0 and model is unlisted in pricingTable", async () => {
    async function* rawGenerator() {
      yield {
        type: "step_start",
        part: {
          sessionID: "ses_unlisted",
        },
      };
      yield {
        type: "step_finish",
        part: {
          sessionID: "ses_unlisted",
          cost: 0,
          tokens: {
            input: 1000,
            output: 200,
          },
        },
      };
    }

    const options: OpenCodeNormalizeOptions = {
      model: "unlisted-model-xyz",
      pricingTable: SAMPLE_PRICING,
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawGenerator(), options)) {
      events.push(event);
    }

    const usageEvt = events.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    if (usageEvt?.type === "usage") {
      expect(usageEvt.record.cost_source).toBe("unknown");
      expect(usageEvt.record.cost_usd).toBe(0);
    }

    const result = events[events.length - 1];
    expect(result.type).toBe("session.result");
    if (result.type === "session.result") {
      expect(result.usage?.cost_source).toBe("unknown");
      expect(result.usage?.cost_usd).toBe(0);
    }
  });

  it("skips invalid or empty NDJSON chunks silently", async () => {
    async function* rawGenerator() {
      yield null;
      yield undefined;
      yield "";
      yield { type: "step_start", sessionID: "ses_valid", part: {} };
      yield {};
      yield { type: "text", sessionID: "ses_valid", part: { text: "clean" } };
    }

    const options: OpenCodeNormalizeOptions = {
      model: "opencode/deepseek-v4.1-flash-free",
    };

    const events: BackendEvent[] = [];
    for await (const event of normalizeOpenCodeStream(rawGenerator(), options)) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe("session.started");
    expect(events[events.length - 1].type).toBe("session.result");
  });
});
