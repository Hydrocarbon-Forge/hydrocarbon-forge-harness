import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendEvent,
  Capabilities,
  SessionResult,
  UsageRecord,
  type SpawnRequest,
} from "../../../src/contracts/index.js";
import {
  normalizeClaudeEvent,
  extractClaudeUsage,
  extractClaudeSessionResult,
} from "../../../src/backends/normalize/claude.js";
import {
  CLAUDE_VERSION_PIN,
  CLAUDE_CAPABILITIES,
  buildClaudeArgs,
  scrubClaudeEnv,
} from "../../../src/backends/adapters/claude.js";
import { DEFAULT_PRICING } from "../../../src/backends/default-pricing.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadFixtureLines(filename: string): string[] {
  const filePath = resolve(here, "../../fixtures/backends/claude", filename);
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function loadFixtureEvents(filename: string): unknown[] {
  return loadFixtureLines(filename).map((line) => JSON.parse(line));
}

// Mirrors the live claude adapter loop: one normalizeClaudeEvent call per parsed line.
async function* normalizeClaudeFixture(items: unknown[]): AsyncIterable<BackendEvent> {
  const seenDenials = new Set<string>();
  for (const item of items) {
    yield* normalizeClaudeEvent(item, { seenDenials });
  }
}

describe("Claude Normalizer: S1 Golden Fixture Tests", () => {
  it("normalizes success.ndjson fixture into canonical stream and session result", async () => {
    const rawEvents = loadFixtureEvents("success.ndjson");
    expect(rawEvents.length).toBeGreaterThan(0);

    const events: BackendEvent[] = [];
    for await (const event of normalizeClaudeFixture(rawEvents)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    expect(events.length).toBe(4);

    // 1. session.started
    expect(events[0].type).toBe("session.started");
    if (events[0].type === "session.started") {
      expect(events[0].session_id).toBe("69c9959f-c9d2-47bd-88a3-c2e2b1c9dad9");
    }

    // 2. assistant.text
    expect(events[1].type).toBe("assistant.text");
    if (events[1].type === "assistant.text") {
      expect(events[1].text).toBe("OK");
    }

    // 3. usage event
    expect(events[2].type).toBe("usage");
    if (events[2].type === "usage") {
      expect(events[2].cumulative).toBe(false);
      expect(events[2].record.cost_usd).toBeCloseTo(0.0001182, 6);
      expect(events[2].record.cost_source).toBe("reported");
      expect(events[2].record.input_tokens).toBe(2);
      expect(events[2].record.output_tokens).toBe(4);
      expect(events[2].record.cache_write_tokens).toBe(580);
      expect(events[2].record.cache_read_tokens).toBe(0);
    }

    // 4. session.result
    expect(events[3].type).toBe("session.result");
    if (events[3].type === "session.result") {
      expect(events[3].ok).toBe(true);
      expect(events[3].exit_code).toBe(0);
      expect(events[3].stop_reason).toBe("end_turn");
      expect(events[3].final_text).toBe("OK");
    }

    // Synthesized SessionResult
    const sessionResult = extractClaudeSessionResult(events, 0);
    expect(SessionResult.safeParse(sessionResult).success).toBe(true);
    expect(sessionResult.ok).toBe(true);
    expect(sessionResult.session_id).toBe("69c9959f-c9d2-47bd-88a3-c2e2b1c9dad9");
    expect(sessionResult.final_text).toBe("OK");
    expect(sessionResult.exit_code).toBe(0);
    expect(sessionResult.denials).toEqual([]);
    expect(sessionResult.usage.cost_usd).toBeCloseTo(0.0001182, 6);
  });

  it("normalizes tool-call.ndjson fixture capturing Bash invocation and execution result", async () => {
    const rawEvents = loadFixtureEvents("tool-call.ndjson");
    const events: BackendEvent[] = [];

    for await (const event of normalizeClaudeFixture(rawEvents)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("session.started");
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("assistant.text");
    expect(types).toContain("usage");
    expect(types).toContain("session.result");

    const toolCall = events.find((e) => e.type === "tool.call");
    expect(toolCall).toBeDefined();
    if (toolCall && toolCall.type === "tool.call") {
      expect(toolCall.name).toBe("Bash");
      expect(toolCall.id).toBe("toolu_019SRRBTq5VeQS8Lqa5Lysb1");
      expect(toolCall.input_summary).toContain("echo hello-tool-ok");
    }

    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === "tool.result") {
      expect(toolResult.id).toBe("toolu_019SRRBTq5VeQS8Lqa5Lysb1");
      expect(toolResult.ok).toBe(true);
      expect(toolResult.output_summary).toContain("hello-tool-ok");
    }

    const textEvent = events.find((e) => e.type === "assistant.text");
    expect(textEvent).toBeDefined();
    if (textEvent && textEvent.type === "assistant.text") {
      expect(textEvent.text).toBe("hello-tool-ok");
    }

    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent && usageEvent.type === "usage") {
      expect(usageEvent.record.reasoning_tokens).toBe(49);
      expect(usageEvent.record.cost_usd).toBeCloseTo(0.00125669, 6);
      expect(usageEvent.record.cost_source).toBe("reported");
    }

    const sessionResult = extractClaudeSessionResult(events, 0);
    expect(sessionResult.ok).toBe(true);
    expect(sessionResult.final_text).toBe("hello-tool-ok");
  });

  it("normalizes session-resume.ndjson fixture echoing session ID across continuation", async () => {
    const rawEvents = loadFixtureEvents("session-resume.ndjson");
    const targetSessionId = "64001678-4648-4d8d-800e-7e703f98d320";

    const events: BackendEvent[] = [];
    for await (const event of normalizeClaudeFixture(rawEvents)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    const started = events.find((e) => e.type === "session.started");
    expect(started).toBeDefined();
    if (started && started.type === "session.started") {
      expect(started.session_id).toBe(targetSessionId);
    }

    const text = events.find((e) => e.type === "assistant.text");
    expect(text).toBeDefined();
    if (text && text.type === "assistant.text") {
      expect(text.text).toBe("hello-tool-ok");
    }

    const result = extractClaudeSessionResult(events, 0);
    expect(result.ok).toBe(true);
    expect(result.session_id).toBe(targetSessionId);
    expect(result.final_text).toBe("hello-tool-ok");
  });

  it("normalizes denial.ndjson fixture capturing permission.denied and failing tool result", async () => {
    const rawEvents = loadFixtureEvents("denial.ndjson");
    const events: BackendEvent[] = [];

    for await (const event of normalizeClaudeFixture(rawEvents)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    const denialEvent = events.find((e) => e.type === "permission.denied");
    expect(denialEvent).toBeDefined();
    if (denialEvent && denialEvent.type === "permission.denied") {
      expect(denialEvent.tool).toBe("Bash");
      expect(denialEvent.reason).toContain("don't ask mode");
    }

    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === "tool.result") {
      expect(toolResult.ok).toBe(false);
      expect(toolResult.output_summary).toContain("Permission to use Bash has been denied");
    }

    const sessionResult = extractClaudeSessionResult(events, 0);
    expect(sessionResult.denials.length).toBeGreaterThan(0);
    expect(sessionResult.denials.some((d) => d.tool === "Bash")).toBe(true);
  });

  it("normalizes budget-exceeded.ndjson fixture marking ok: false with budget stop reason", async () => {
    const rawEvents = loadFixtureEvents("budget-exceeded.ndjson");
    const events: BackendEvent[] = [];

    for await (const event of normalizeClaudeFixture(rawEvents)) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    const resultEvent = events.find((e) => e.type === "session.result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "session.result") {
      expect(resultEvent.ok).toBe(false);
      expect(resultEvent.stop_reason).toBe("budget");
      expect(resultEvent.exit_code).toBe(1);
    }

    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent && usageEvent.type === "usage") {
      expect(usageEvent.record.cost_usd).toBeCloseTo(0.00134567, 6);
      expect(usageEvent.record.cost_source).toBe("reported");
    }

    const sessionResult = extractClaudeSessionResult(events, 1);
    expect(sessionResult.ok).toBe(false);
    expect(sessionResult.exit_code).toBe(1);
    expect(sessionResult.usage.cost_usd).toBeCloseTo(0.00134567, 6);
  });
});

describe("Claude Normalizer: Edge Cases and Stream Robustness", () => {
  it("ignores rate_limit_event with status 'allowed' without emitting error", () => {
    const allowedEvent = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1792184400,
      },
    };

    const emitted = normalizeClaudeEvent(allowedEvent);
    expect(emitted).toEqual([]);
  });

  it("emits error event of kind rate_limit when rate_limit_event status is rejected", () => {
    const rejectedEvent = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1792184400,
        rateLimitType: "five_hour",
      },
    };

    const emitted = normalizeClaudeEvent(rejectedEvent);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("error");
    if (emitted[0].type === "error") {
      expect(emitted[0].kind).toBe("rate_limit");
    }
  });

  it("skips thinking content blocks without emitting assistant.text", () => {
    const thinkingMsg = {
      type: "assistant",
      message: {
        model: "claude-haiku-5-5",
        content: [
          { type: "thinking", thinking: "internal reasoning step", signature: "sig123" },
          { type: "text", text: "Visible answer" },
        ],
      },
    };

    const emitted = normalizeClaudeEvent(thinkingMsg);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("assistant.text");
    if (emitted[0].type === "assistant.text") {
      expect(emitted[0].text).toBe("Visible answer");
    }
  });

  it("safely ignores malformed or unknown events without throwing", () => {
    expect(normalizeClaudeEvent(null)).toEqual([]);
    expect(normalizeClaudeEvent("raw-string-line")).toEqual([]);
    expect(normalizeClaudeEvent({ type: "unknown_future_stream_event", data: {} })).toEqual([]);
    expect(normalizeClaudeEvent({ type: "assistant", message: {} })).toEqual([]);
  });

  it("synthesizes SessionResult when process is terminated prematurely before result event", () => {
    const events: BackendEvent[] = [
      { type: "session.started", session_id: "premature-123" },
      { type: "assistant.text", text: "Starting task..." },
    ];

    const resultBudget = extractClaudeSessionResult(events, 137, "budget");
    expect(resultBudget.ok).toBe(false);
    expect(resultBudget.killed_for).toBe("budget");
    expect(resultBudget.exit_code).toBe(137);

    const resultCancel = extractClaudeSessionResult(events, 137, "cancel");
    expect(resultCancel.ok).toBe(false);
    expect(resultCancel.killed_for).toBe("cancel");

    const resultCrash = extractClaudeSessionResult(events, 1);
    expect(resultCrash.ok).toBe(false);
    expect(resultCrash.final_text).toContain("unexpectedly");
    expect(resultCrash.exit_code).toBe(1);
  });

  it("extractClaudeUsage handles missing total_cost_usd by computing with pricingTable or marking cost_source: unknown", () => {
    const rawResultWithoutCost = {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    };

    // With pricingTable: computed cost
    const usageWithPricing = extractClaudeUsage(
      rawResultWithoutCost,
      "claude-haiku-5-5",
      DEFAULT_PRICING,
    );
    expect(UsageRecord.safeParse(usageWithPricing).success).toBe(true);
    expect(usageWithPricing.input_tokens).toBe(100);
    expect(usageWithPricing.output_tokens).toBe(50);
    // (100 * 0.1 + 50 * 0.5) / 1M = (10 + 25) / 1M = 0.000035
    expect(usageWithPricing.cost_usd).toBeCloseTo(0.000035, 6);
    expect(usageWithPricing.cost_source).toBe("computed");

    // Without pricingTable: cost_source unknown, cost 0
    const usageWithoutPricing = extractClaudeUsage(rawResultWithoutCost, "claude-haiku-5-5");
    expect(UsageRecord.safeParse(usageWithoutPricing).success).toBe(true);
    expect(usageWithoutPricing.cost_usd).toBe(0);
    expect(usageWithoutPricing.cost_source).toBe("unknown");
  });
});

describe("Claude Adapter: Argument Synthesis & Environment Scrubbing", () => {
  it("buildClaudeArgs generates correct headless flags and defaults", () => {
    const req: SpawnRequest = {
      role: "worker",
      cwd: "/tmp/test",
      prompt: "echo minimal",
      model: "claude-haiku-5-5",
      session: { id: "12345678-1234-1234-1234-123456789abc" },
      permission: { allow: [], deny: [] },
      budget: { timeout_ms: 10000 },
    };

    const args = buildClaudeArgs(req);

    // Prepend prompt with -p
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("echo minimal");

    // Output format and verbosity
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");

    // Model specified
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");

    // Effort omitted when undefined
    expect(args).not.toContain("--effort");

    // Permission flags
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("--permission-prompts");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");

    // Disallowed tools must always include Agent
    expect(args).toContain("--disallowedTools");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Agent");

    // Allowed tools never emitted (permissions are bypassed)
    expect(args).not.toContain("--allowedTools");

    // Session id
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("12345678-1234-1234-1234-123456789abc");

    // Budget omitted when undefined
    expect(args).not.toContain("--max-budget-usd");
  });

  it("buildClaudeArgs handles effort, tool allow/deny, resume, and budget cap", () => {
    const req: SpawnRequest = {
      role: "worker",
      cwd: "/tmp/test",
      prompt: "scenario:resume",
      model: "claude-3-7-sonnet",
      effort: "high",
      permission: {
        allow: ["Bash", "Edit"],
        deny: ["WebFetch"],
      },
      budget: {
        max_usd: 2.5,
        timeout_ms: 30000,
      },
      session: {
        resume: "12345678-1234-1234-1234-123456789abc",
      },
    };

    const args = buildClaudeArgs(req);

    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");

    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("12345678-1234-1234-1234-123456789abc");
    expect(args).not.toContain("--session-id");

    // Allow rules are not emitted; permissions are bypassed (owner decision 2026-10-19)
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--dangerously-skip-permissions");

    expect(args).toContain("--disallowedTools");
    const disallowed = args[args.indexOf("--disallowedTools") + 1];
    expect(disallowed).toContain("Agent");
    expect(disallowed).toContain("WebFetch");

    expect(args).toContain("--max-budget-usd");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.5");
  });

  it("scrubClaudeEnv preserves allowlisted variables and excludes parent secrets", () => {
    const originalEnv = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-secret-123";
      process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-456";
      process.env.PATH = "/bin:/usr/bin";
      process.env.HOME = "/home/testuser";

      const scrubbed = scrubClaudeEnv({
        CUSTOM_RUN_VAR: "run-val-789",
      });

      expect(scrubbed.PATH).toBe("/bin:/usr/bin");
      expect(scrubbed.HOME).toBe("/home/testuser");
      expect(scrubbed.CUSTOM_RUN_VAR).toBe("run-val-789");

      // Secrets and arbitrary environment variables stripped
      expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
      expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });

  it("exposes CLAUDE_VERSION_PIN and CLAUDE_CAPABILITIES conforming to contracts", () => {
    expect(CLAUDE_VERSION_PIN).toBe("2.1.304");
    expect(Capabilities.safeParse(CLAUDE_CAPABILITIES).success).toBe(true);
    expect(CLAUDE_CAPABILITIES.name).toBe("claude");
    expect(CLAUDE_CAPABILITIES.version_pin).toBe("2.1.304");
    expect(CLAUDE_CAPABILITIES.effort).toBe(true);
    expect(CLAUDE_CAPABILITIES.structured_output).toBe(false);
    expect(CLAUDE_CAPABILITIES.budget_flag).toBe(true);
    expect(CLAUDE_CAPABILITIES.cost_reported).toBe(true);
    expect(CLAUDE_CAPABILITIES.resume).toBe(true);
    expect(CLAUDE_CAPABILITIES.permission_denial_signal).toBe("event");
    expect(CLAUDE_CAPABILITIES.sandbox_flag).toBe(false);
    expect(CLAUDE_CAPABILITIES.native_subagents_headless).toBe(false);
  });
});
