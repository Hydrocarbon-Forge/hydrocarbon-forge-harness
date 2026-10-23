import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  AgyAdapter,
  buildAgyArgv,
  type AgyAdapterOptions,
} from "../../../src/backends/adapters/agy.js";

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

// 1. Run the shared adapter conformance suite against AgyAdapter.
//
// soft_deny is skipped for agy: the suite asserts the denied tool is the name in
// req.permission.deny, which a real agy run cannot know - agy has no deny-list flag
// (permission rules live in settings.json, S3), so the only channel that could
// carry the name was the `--denial-tool` test-harness flag that R2.5 removed.
// Denial detection for agy is still covered below by the agy-specific test, which
// asserts the tool as agy reports it ("RunCommand"/"command").
runAdapterConformanceSuite("AgyAdapter (fake dialect)", () => createAdapter(), {
  skipScenarios: ["soft_deny"],
});

describe("AgyAdapter - Capabilities and Contracts", () => {
  it("exposes exact Agy capability flags as specified in TASK.md and Plan §11.1", () => {
    const adapter = createAdapter();
    const caps = adapter.capabilities;

    expect(Capabilities.safeParse(caps).success).toBe(true);
    expect(caps.name).toBe("agy");
    expect(caps.version_pin).toBe("1.4.2");
    expect(caps.effort).toBe(true);
    expect(caps.structured_output).toBe(false);
    expect(caps).not.toHaveProperty('budget_flag');
    expect(caps.cost_reported).toBe(false);
    expect(caps.resume).toBe(true);
    expect(caps.permission_denial_signal).toBe("stderr");
    // R2.5: --sandbox is OS isolation and grants nothing to a headless run, so the
    // flag is false and never passed.
    expect(caps.sandbox_flag).toBe(false);
    expect(caps.native_subagents_headless).toBe(false);
  });

  it("validateEnvironment returns ok: true when binary matches 1.4.2 pin", async () => {
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

  it("omits effort slugs agy does not accept instead of clamping them", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-effort-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "gemini-3.8-flash-low",
        effort: "max", // S3: agy 1.4.0 accepts only low/medium/high, so this is omitted
        permission: { allow: [], deny: [] },
      };

      const argv = buildAgyArgv(req);
      expect(argv).not.toContain("--effort");

      // Omitting the flag also means the run does not hit the effort conflict the
      // fake dialect reproduces from S3, so the session completes normally.
      const handle = adapter.spawn(req);
      const res = await handle.result();
      expect(SessionResult.safeParse(res).success).toBe(true);
      expect(res.ok).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("passes an accepted effort slug through to the argv", async () => {
    const adapter = createAdapter();
    const argv = buildAgyArgv({
      role: "worker",
      cwd: "/worktree/repo",
      prompt: "echo hello",
      model: "gemini-3.8-flash-high",
      effort: "high",
      permission: { allow: [], deny: [] },
    });
    expect(argv).toContain("--effort");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    expect(adapter.capabilities.effort).toBe(true);
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
      // The tool is the name agy reports (display name from denied_actions, or the
      // action from the stderr notice). It is not the deny-list name, because agy
      // has no flag that receives a deny list - see the conformance skip above.
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

  it("does not pass the fake-harness variables from the process environment to the child", async () => {
    // R2.5 defect 2: FAKE_SCENARIO and AGY_LIVE were in the env allowlist, so a
    // test-harness variable leaked into a real agy run. The child now receives only
    // the allowlisted names plus the spawn env of the request.
    const cwd = mkdtempSync(join(tmpdir(), "agy-env-allowlist-"));
    const previousScenario = process.env.FAKE_SCENARIO;
    const previousLive = process.env.AGY_LIVE;
    try {
      process.env.FAKE_SCENARIO = "soft_deny";
      process.env.AGY_LIVE = "1";

      const wrapper = join(cwd, "env-dump.mjs");
      writeFileSync(
        wrapper,
        "#!/usr/bin/env node\n" +
          "import { writeFileSync } from 'node:fs';\n" +
          "writeFileSync('env.json', JSON.stringify(process.env));\n" +
          "process.exit(0);\n",
        "utf8"
      );
      chmodSync(wrapper, 0o755);

      const adapter = createAdapter({ bin: wrapper });
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: [] },
      };

      const handle = adapter.spawn(req);
      const res = await handle.result();

      const childEnv = JSON.parse(readFileSync(join(cwd, "env.json"), "utf8"));
      expect(childEnv.FAKE_SCENARIO).toBeUndefined();
      expect(childEnv.AGY_LIVE).toBeUndefined();
      expect(childEnv.PATH).toBeDefined();
      expect(res.ok).toBe(true);
    } finally {
      if (previousScenario === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = previousScenario;
      if (previousLive === undefined) delete process.env.AGY_LIVE;
      else process.env.AGY_LIVE = previousLive;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reaches the fake dialect through the request env, the route tests must use now", async () => {
    // With the harness names out of the allowlist, a test sets FAKE_SCENARIO in
    // req.env; the dialect reads it from its own environment, so the scenario still
    // runs. A prompt with no scenario marker proves the env is what selected it.
    const cwd = mkdtempSync(join(tmpdir(), "agy-env-scenario-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: ["command"] },
        env: { FAKE_SCENARIO: "soft_deny" },
      };

      const handle = adapter.spawn(req);
      const res = await handle.result();

      expect(res.ok).toBe(false);
      expect(res.denials.length).toBeGreaterThan(0);
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

      // Invariant: the session total is the sum of the run's usage events, which are
      // the per-step records. On a resumed conversation agy's result usage is
      // cumulative over earlier turns, so the total must not equal it.
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents.length).toBeGreaterThan(0);
      const summedInput = usageEvents.reduce(
        (sum, e) => (e.type === "usage" ? sum + e.record.input_tokens : sum),
        0
      );
      const summedCost = usageEvents.reduce(
        (sum, e) => (e.type === "usage" ? sum + e.record.cost_usd : sum),
        0
      );
      expect(res.usage.input_tokens).toBe(summedInput);
      expect(res.usage.cost_usd).toBeCloseTo(summedCost, 10);
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

  it("terminates process group on kill('timeout') with killed_for: 'timeout'", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agy-kill-budget-"));
    try {
      const adapter = createAdapter();
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "scenario:hang",
        model: "gemini-3.8-flash-low",
        permission: { allow: [], deny: [] },
      };

      const handle = adapter.spawn(req);
      await new Promise((r) => setTimeout(r, 100));
      await handle.kill("timeout");

      const res = await handle.result();
      expect(res.ok).toBe(false);
      expect(res.killed_for).toBe("timeout");
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
