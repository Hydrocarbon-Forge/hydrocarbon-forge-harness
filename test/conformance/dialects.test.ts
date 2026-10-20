import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { normalizeClaudeEvent } from "../../src/backends/normalize/claude.js";
import { normalizeOpenCodeStream } from "../../src/backends/normalize/opencode.js";
import {
  AgyNormalizer,
  type AgyNormalizerOptions,
  type AgyRawEvent,
} from "../../src/backends/normalize/agy.js";
import type { BackendEvent, PricingTable } from "../../src/contracts/index.js";

const BIN_DIR = resolve(__dirname, "../fixtures/fake-harness/bin");

const samplePricing: PricingTable = {
  asOf: "2026-10-16",
  sources: [],
  models: {
    "gemini-3.8-flash-low": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
      cache_read_per_mtok: 0.075,
    },
  },
};

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

// Mirrors the live claude adapter loop: one normalizeClaudeEvent call per stdout line.
async function* normalizeClaudeLines(lines: string[]): AsyncIterable<BackendEvent> {
  const seenDenials = new Set<string>();
  for (const line of lines) {
    yield* normalizeClaudeEvent(JSON.parse(line), { seenDenials });
  }
}

// Mirrors the live agy adapter: AgyNormalizer per event, then finalize at exit.
function normalizeAgyEvents(raws: AgyRawEvent[], options: AgyNormalizerOptions): BackendEvent[] {
  const normalizer = new AgyNormalizer(options);
  const events: BackendEvent[] = [];
  for (const raw of raws) {
    events.push(...normalizer.normalizeEvent(raw));
  }
  events.push(...normalizer.finalize(0));
  return events;
}

describe("Dialect output normalizer conformance", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dialect-conformance-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("normalizes claude stream output with matching session_id and positive token usage", async () => {
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const scenarioFile = join(tempDir, "scenario.json");
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        calls: [
          {
            reply: "Hello Claude",
            usage: { input: 42, output: 17, cache_read: 0, cache_write: 0 },
            cost_usd: 0.0001,
          },
        ],
      }),
      "utf8"
    );

    const binPath = join(BIN_DIR, "claude");
    const result = spawnSync(
      binPath,
      ["--session-id", sessionId, "-p", "run task"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: { ...process.env, FAKE_SCENARIO_FILE: scenarioFile },
      }
    );

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);

    const events: BackendEvent[] = [];
    for await (const ev of normalizeClaudeLines(lines)) {
      events.push(ev);
    }

    const started = events.find((e) => e.type === "session.started");
    expect(started).toBeDefined();
    if (started && started.type === "session.started") {
      expect(started.session_id).toBe(sessionId);
    }

    const usageEv = events.find((e) => e.type === "usage");
    expect(usageEv).toBeDefined();
    if (usageEv && usageEv.type === "usage") {
      expect(usageEv.record.input_tokens).toBeGreaterThan(0);
      expect(usageEv.record.output_tokens).toBeGreaterThan(0);
    }

    const sessionResult = events.find((e) => e.type === "session.result");
    expect(sessionResult).toBeDefined();
    if (sessionResult && sessionResult.type === "session.result") {
      expect(sessionResult.ok).toBe(true);
      expect(sessionResult.usage?.input_tokens).toBeGreaterThan(0);
      expect(sessionResult.usage?.output_tokens).toBeGreaterThan(0);
    }
  });

  it("normalizes opencode stream output with matching session_id and positive token usage", async () => {
    const sessionId = "ses_conformance123";
    const scenarioFile = join(tempDir, "scenario.json");
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        calls: [
          {
            reply: "Hello OpenCode",
            usage: { input: 120, output: 45, cache_read: 10, cache_write: 0 },
          },
        ],
      }),
      "utf8"
    );

    const binPath = join(BIN_DIR, "opencode");
    const result = spawnSync(binPath, ["-s", sessionId, "run", "do task"], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, FAKE_SCENARIO_FILE: scenarioFile },
    });

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));

    const events: BackendEvent[] = [];
    for await (const ev of normalizeOpenCodeStream(toAsyncIterable(parsed), {
      model: "test-model",
    })) {
      events.push(ev);
    }

    const started = events.find((e) => e.type === "session.started");
    expect(started).toBeDefined();
    if (started && started.type === "session.started") {
      expect(started.session_id).toBe(sessionId);
    }

    const usageEv = events.find((e) => e.type === "usage");
    expect(usageEv).toBeDefined();
    if (usageEv && usageEv.type === "usage") {
      expect(usageEv.record.input_tokens).toBeGreaterThan(0);
      expect(usageEv.record.output_tokens).toBeGreaterThan(0);
    }

    const sessionResult = events.find((e) => e.type === "session.result");
    expect(sessionResult).toBeDefined();
    if (sessionResult && sessionResult.type === "session.result") {
      expect(sessionResult.ok).toBe(true);
      expect(sessionResult.usage?.input_tokens).toBeGreaterThan(0);
      expect(sessionResult.usage?.output_tokens).toBeGreaterThan(0);
    }
  });

  it("normalizes agy stream output with matching session_id and positive token usage", async () => {
    const conversationId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const scenarioFile = join(tempDir, "scenario.json");
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        calls: [
          {
            reply: "Hello Agy",
            usage: { input: 11827, output: 13, cache_read: 0, cache_write: 0 },
          },
        ],
      }),
      "utf8"
    );

    const binPath = join(BIN_DIR, "agy");
    const result = spawnSync(
      binPath,
      ["--conversation", conversationId, "-p", "run task"],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: { ...process.env, FAKE_SCENARIO_FILE: scenarioFile },
      }
    );

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const parsed: AgyRawEvent[] = lines.map((l) => JSON.parse(l));

    const events = normalizeAgyEvents(parsed, {
      model: "gemini-3.8-flash-low",
      pricing: samplePricing,
    });

    const started = events.find((e) => e.type === "session.started");
    expect(started).toBeDefined();
    if (started && started.type === "session.started") {
      expect(started.session_id).toBe(conversationId);
    }

    const usageEv = events.find((e) => e.type === "usage");
    expect(usageEv).toBeDefined();
    if (usageEv && usageEv.type === "usage") {
      expect(usageEv.record.input_tokens).toBeGreaterThan(0);
      expect(usageEv.record.output_tokens).toBeGreaterThan(0);
    }

    const sessionResult = events.find((e) => e.type === "session.result");
    expect(sessionResult).toBeDefined();
    if (sessionResult && sessionResult.type === "session.result") {
      expect(sessionResult.ok).toBe(true);
      expect(sessionResult.usage?.input_tokens).toBeGreaterThan(0);
      expect(sessionResult.usage?.output_tokens).toBeGreaterThan(0);
    }
  });
});
