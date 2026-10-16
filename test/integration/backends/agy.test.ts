import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  Capabilities,
  EnvReport,
  SpawnRequest,
  SessionResult,
  BackendEvent,
  type PricingTable,
} from "../../../src/contracts/index.js";
import { runAdapterConformanceSuite } from "../../conformance/index.js";
import { AgyAdapter, type AgyAdapterOptions } from "../../../src/backends/adapters/agy.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgyBin = resolve(here, "../../fixtures/fake-harness/dialects/agy.mjs");

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

function createAdapter(overrides?: Partial<AgyAdapterOptions>): AgyAdapter {
  return new AgyAdapter({
    bin: fakeAgyBin,
    pricing: samplePricing,
    ...overrides,
  });
}

// 1. Run the shared adapter conformance suite against AgyAdapter
runAdapterConformanceSuite("AgyAdapter (fake dialect)", () => createAdapter());

describe("AgyAdapter - Capabilities and Contracts", () => {
  it("exposes exact Agy capability flags as specified in TASK.md and Plan §11.1", () => {
    const adapter = createAdapter();
    const caps = adapter.capabilities;

    expect(Capabilities.safeParse(caps).success).toBe(true);
    expect(caps.name).toBe("agy");
    expect(caps.version_pin).toBe("1.4.0");
    expect(caps.effort).toBe(true);
    expect(caps.structured_output).toBe(false);
    expect(caps.budget_flag).toBe(false);
    expect(caps.cost_reported).toBe(false);
    expect(caps.resume).toBe(true);
    expect(caps.permission_denial_signal).toBe("stderr");
    expect(caps.sandbox_flag).toBe(true);
    expect(caps.native_subagents_headless).toBe(false);
  });

  it("validateEnvironment returns ok: true when binary matches 1.4.0 pin", async () => {
    const adapter = createAdapter();
    const report = await adapter.validateEnvironment();

    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.pin_matches).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("validateEnvironment reports pin mismatch if binary returns non-matching version", async () => {
    // Create an adapter pointing to node with a script that outputs version 1.3.0
    const adapter = createAdapter({
      bin: "echo", // 'echo 1.3.0' simulates mismatch
    });
    const report = await adapter.validateEnvironment();

    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.pin_matches).toBe(false);
    expect(report.problems.some((p) => p.includes("mismatch"))).toBe(true);
  });

  it("validateEnvironment reports ok: false if binary is not found", async () => {
    const adapter = createAdapter({
      bin: "/nonexistent/path/to/agy",
    });
    const report = await adapter.validateEnvironment();

    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.pin_matches).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });
});

describe("AgyAdapter - Execution, Supervision, and Lifecycle", () => {
  it("persists raw ndjson stream to raw/<session_id>.ndjson", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-raw-stream-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      };

      const handle = adapter.spawn(req);
      const events: BackendEvent[] = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      const res = await handle.result();
      expect(res.ok).toBe(true);

      const rawFile = join(cwd, "raw", `${res.session_id}.ndjson`);
      expect(existsSync(rawFile)).toBe(true);
      const content = readFileSync(rawFile, "utf8");
      expect(content).toContain('"event":"init"');
      expect(content).toContain('"event":"result"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("clamps or prevents effort flag conflict on flash models (gemini-3.8-flash-low + max effort)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-effort-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "gemini-3.8-flash-low",
        effort: "max", // S3 spike confirmed --effort max conflicts with flash-low
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      };

      // Adapter should clamp effort to high or execute safely without crashing with exit 1 conflict
      const handle = adapter.spawn(req);
      const res = await handle.result();
      expect(SessionResult.safeParse(res).success).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("identifies soft-denial on exit 0 and populates SessionResult.denials with ok: false", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-soft-deny-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "scenario:soft_deny",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: ["command"] },
        budget: { timeout_ms: 30000 },
      };

      const handle = adapter.spawn(req);
      const events: BackendEvent[] = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      const res = await handle.result();
      expect(SessionResult.safeParse(res).success).toBe(true);

      // Invariant I11: Never treat exit code 0 alone as success!
      expect(res.exit_code).toBe(0);
      expect(res.ok).toBe(false);
      expect(res.denials.length).toBeGreaterThan(0);
      expect(
        res.denials.some((d) => d.tool === "RunCommand" || d.tool === "command")
      ).toBe(true);

      const denialEvent = events.find((e) => e.type === "permission.denied");
      expect(denialEvent).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("enforces Cost Source Invariant: SessionResult.usage.cost_source is always 'computed'", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-cost-source-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      };

      const handle = adapter.spawn(req);
      const res = await handle.result();

      expect(res.usage.cost_source).toBe("computed");
      expect(res.usage.backend).toBe("agy");
      expect(res.usage.cost_usd).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supports session continuation via --conversation and maintains session ID", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-resume-"));
    try {
      const adapter = createAdapter();
      const resumeId = "conv-persisted-resume-123";
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "scenario:resume",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
        session: { resume: resumeId },
      };

      const handle = adapter.spawn(req);
      const events: BackendEvent[] = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      const res = await handle.result();
      expect(res.ok).toBe(true);
      expect(res.session_id).toBe(resumeId);

      const startEvent = events.find((e) => e.type === "session.started");
      if (startEvent?.type === "session.started") {
        expect(startEvent.session_id).toBe(resumeId);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("terminates process group on kill('cancel') with killed_for: 'cancel'", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-kill-cancel-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "scenario:hang",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      };

      const handle = adapter.spawn(req);
      expect(handle.pid).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 100));
      await handle.kill("cancel");

      const res = await handle.result();
      expect(res.ok).toBe(false);
      expect(res.killed_for).toBe("cancel");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("terminates process group on kill('budget') with killed_for: 'budget'", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-kill-budget-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "scenario:hang",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      };

      const handle = adapter.spawn(req);
      await new Promise((r) => setTimeout(r, 100));
      await handle.kill("budget");

      const res = await handle.result();
      expect(res.ok).toBe(false);
      expect(res.killed_for).toBe("budget");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("AgyAdapter - Live Execution Gate", () => {
  it("skips live agy calls unless AGY_LIVE environment variable is defined", () => {
    if (!process.env.AGY_LIVE) {
      expect(process.env.AGY_LIVE).toBeUndefined();
      return;
    }

    // Only executed when AGY_LIVE is explicitly set
    const realAdapter = new AgyAdapter({
      bin: "agy",
      pricing: samplePricing,
    });
    expect(realAdapter.capabilities.name).toBe("agy");
  });
});
