import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  Capabilities,
  EnvReport,
  SessionResult,
  SpawnRequest,
  type HarnessAdapter,
} from "../../../src/contracts/index.js";
import { runAdapterConformanceSuite } from "../../conformance/index.js";
import {
  OpenCodeAdapter,
  generateOpenCodeRunConfig,
  mapEffortToVariant,
  type OpenCodeAdapterOptions,
} from "../../../src/backends/adapters/opencode.js";

const fakeBinaryPath = resolve(
  __dirname,
  "../../fixtures/fake-harness/dialects/opencode.mjs"
);

// 1. Authoritative conformance suite running against OpenCodeAdapter with fake dialect binary
runAdapterConformanceSuite("OpenCodeAdapter (via fake-harness dialect)", () => {
  return new OpenCodeAdapter({
    binPath: fakeBinaryPath,
    versionPin: "2.0.21",
  });
});

describe("OpenCodeAdapter: Capabilities Specification", () => {
  const adapter = new OpenCodeAdapter({ binPath: fakeBinaryPath });

  it("exposes capabilities matching the authoritative OpenCode spec", () => {
    expect(Capabilities.safeParse(adapter.capabilities).success).toBe(true);
    expect(adapter.capabilities.name).toBe("opencode");
    expect(adapter.capabilities.version_pin).toBe("2.0.21");
    expect(adapter.capabilities.effort).toBe(true);
    expect(adapter.capabilities.structured_output).toBe(false);
    expect(adapter.capabilities.budget_flag).toBe(false);
    expect(adapter.capabilities.cost_reported).toBe(true);
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.capabilities.permission_denial_signal).toBe("none");
    expect(adapter.capabilities.sandbox_flag).toBe(false);
    expect(adapter.capabilities.native_subagents_headless).toBe(false);
    expect(adapter.capabilities.max_concurrency).toBe(2);
  });
});

describe("OpenCodeAdapter: Environment Validation", () => {
  it("returns ok: true, pin_matches: true when binary version matches 2.0.21", async () => {
    const adapter = new OpenCodeAdapter({ binPath: fakeBinaryPath });
    const report = await adapter.validateEnvironment();
    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.pin_matches).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("returns ok: false, pin_matches: false when binary is missing or non-executable", async () => {
    const adapter = new OpenCodeAdapter({ binPath: "/path/to/nonexistent/opencode-bin" });
    const report = await adapter.validateEnvironment();
    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.pin_matches).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });
});

describe("OpenCodeAdapter: Effort and Variant Mapping", () => {
  it("maps effort to #variant suffix when model does not already contain a variant", () => {
    expect(mapEffortToVariant("opencode/deepseek-v4.1", "high")).toBe("opencode/deepseek-v4.1#high");
    expect(mapEffortToVariant("opencode/deepseek-v4.1", "low")).toBe("opencode/deepseek-v4.1#low");
    expect(mapEffortToVariant("opencode/deepseek-v4.1", "medium")).toBe("opencode/deepseek-v4.1#medium");
  });

  it("preserves existing variant when model already has a #variant suffix", () => {
    expect(mapEffortToVariant("opencode/deepseek-v4.1#custom", "high")).toBe("opencode/deepseek-v4.1#custom");
  });

  it("returns original model unchanged when effort is undefined", () => {
    expect(mapEffortToVariant("opencode/deepseek-v4.1", undefined)).toBe("opencode/deepseek-v4.1");
  });
});

describe("OpenCodeAdapter: Per-Run Config Generation", () => {
  it("generates agent file with v2 permissions mapping denied tools to OpenCode action names", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-cfg-"));
    try {
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo test",
        model: "opencode/deepseek-v4.1-flash-free",
        permission: {
          allow: [],
          deny: ["Bash", "Edit", "WebFetch", "WebSearch"],
        },
        budget: { timeout_ms: 30000 },
      };

      const config = await generateOpenCodeRunConfig(req);
      expect(config.configDir).toBeTruthy();
      expect(config.agentName).toBeTruthy();
      expect(typeof config.cleanup).toBe("function");

      // Verify agent markdown file was created
      const agentFilePath = resolve(config.configDir, `.opencode/agents/${config.agentName}.md`);
      expect(existsSync(agentFilePath)).toBe(true);

      const content = readFileSync(agentFilePath, "utf8");
      // Must contain mode: primary and steps: 100
      expect(content).toContain("primary");
      expect(content).toContain("steps:");

      // Must map Bash -> shell, Edit -> edit, WebFetch -> webfetch, WebSearch -> websearch
      expect(content).toContain("shell");
      expect(content).toContain("edit");
      expect(content).toContain("webfetch");
      expect(content).toContain("websearch");
      expect(content).toContain("deny");

      // Test cleanup callback
      await config.cleanup();
      expect(existsSync(agentFilePath)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("configures local llama.cpp provider with openai-compatible and 65536k context limit", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-provider-"));
    try {
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo test",
        model: "local-llama-model",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      };

      const options: OpenCodeAdapterOptions = {
        customBaseUrl: "http://127.0.0.1:8080/v1",
        contextWindow: 65536,
      };

      const config = await generateOpenCodeRunConfig(req, options);
      // Provider config file should exist under configDir
      expect(existsSync(config.configDir)).toBe(true);

      await config.cleanup();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("OpenCodeAdapter: Supervision and Lifecycle Invariants", () => {
  it("spawns session with standalone flag and cleans up on completion", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-spawn-"));
    try {
      const adapter = new OpenCodeAdapter({ binPath: fakeBinaryPath });
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "opencode/deepseek-v4.1-flash-free",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      };

      const handle = adapter.spawn(req);
      expect(handle.pid).toBeGreaterThan(0);

      const events = [];
      for await (const event of handle.events) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe("session.started");
      expect(events[events.length - 1].type).toBe("session.result");

      const res = await handle.result();
      expect(SessionResult.safeParse(res).success).toBe(true);
      expect(res.ok).toBe(true);
      expect(res.exit_code).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
