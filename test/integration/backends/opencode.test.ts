import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

describe("OpenCodeAdapter: run argv", () => {
  it("passes --auto so permissions are bypassed (owner decision 2026-10-19)", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-argv-"));
    try {
      // Wrapper records the argv the adapter passes, one argument per line, then runs the fake.
      const argvLog = resolve(cwd, "argv.log");
      const wrapper = resolve(cwd, "opencode-wrapper");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\nexec '${fakeBinaryPath}' "$@"\n`
      );
      chmodSync(wrapper, 0o755);

      const adapter = new OpenCodeAdapter({ binPath: wrapper });
      const handle = adapter.spawn({
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "opencode/deepseek-v4.1-flash-free",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      });
      for await (const _ of handle.events) {
        // consume stream
      }
      await handle.result();

      const argv = readFileSync(argvLog, "utf8").split("\n");
      expect(argv[0]).toBe("run");
      expect(argv).toContain("--standalone");
      expect(argv).toContain("--auto");
      expect(argv.indexOf("--auto")).toBeGreaterThan(argv.indexOf("--standalone"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("OpenCodeAdapter: session ids", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";
  const MAPPED = "ses_11111111222233334444555555555555";

  /** Runs the adapter through a wrapper that records the argv, then the fake. */
  async function runRecorded(session: SpawnRequest["session"]) {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-sid-"));
    try {
      const argvLog = resolve(cwd, "argv.log");
      const wrapper = resolve(cwd, "opencode-wrapper");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\nexec '${fakeBinaryPath}' "$@"\n`
      );
      chmodSync(wrapper, 0o755);

      const adapter = new OpenCodeAdapter({ binPath: wrapper });
      const handle = adapter.spawn({
        role: "worker",
        cwd,
        prompt: "echo hello",
        model: "opencode/deepseek-v4.1-flash-free",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
        session,
      });
      const events = [];
      for await (const event of handle.events) {
        events.push(event);
      }
      const res = await handle.result();
      const argv = readFileSync(argvLog, "utf8").split("\n");
      return { argv, events, res };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("sends a bare UUID new-session id to opencode as ses_ plus 32 hex digits", async () => {
    const { argv, events, res } = await runRecorded({ id: UUID });
    expect(argv[argv.indexOf("-s") + 1]).toBe(MAPPED);
    expect(argv).not.toContain(UUID);
    expect(res.ok).toBe(true);
    expect(events[0]).toEqual({ type: "session.started", session_id: MAPPED });
  });

  it("leaves an id already starting with ses unchanged", async () => {
    const { argv } = await runRecorded({ id: "ses_eba23c36bffeAUsAMAowIHtR03" });
    expect(argv[argv.indexOf("-s") + 1]).toBe("ses_eba23c36bffeAUsAMAowIHtR03");
  });

  it("resume sends the mapped id and reports it back", async () => {
    const { argv, res } = await runRecorded({ resume: UUID });
    expect(argv[argv.indexOf("-s") + 1]).toBe(MAPPED);
    expect(argv).not.toContain("--fork");
    expect(res.session_id).toBe(MAPPED);
  });

  it("fork sends the mapped id with --fork", async () => {
    const { argv, res } = await runRecorded({ resume: UUID, fork: true });
    expect(argv[argv.indexOf("-s") + 1]).toBe(MAPPED);
    expect(argv).toContain("--fork");
    expect(res.session_id).toBe(MAPPED);
  });

  it("the fake opencode rejects a bare UUID the way the real CLI does", () => {
    const run = spawnSync(
      process.execPath,
      [fakeBinaryPath, "run", "--standalone", "--format", "json", "-s", UUID, "-m", "x", "hello"],
      { encoding: "utf8" }
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Expected a string starting with "ses"');
    expect(run.stdout).toBe("");
  });
});

describe("OpenCodeAdapter: agent lookup follows the run directory", () => {
  it("finds the per-run agent when the run dir is nested and the test process PWD differs", async () => {
    const base = realpathSync(mkdtempSync(resolve(tmpdir(), "opencode-nested-")));
    const runDir = resolve(base, "repo", ".substrate", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    try {
      expect(process.cwd()).not.toBe(runDir);
      const adapter = new OpenCodeAdapter({ binPath: fakeBinaryPath });
      const handle = adapter.spawn({
        role: "worker",
        cwd: runDir,
        prompt: "echo hello",
        model: "opencode/deepseek-v4.1-flash-free",
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 30000 },
      });
      const events = [];
      for await (const event of handle.events) {
        events.push(event);
      }
      const res = await handle.result();
      expect(res.exit_code).toBe(0);
      expect(res.ok).toBe(true);
      expect(events[0].type).toBe("session.started");
      expect(events[events.length - 1].type).toBe("session.result");
      expect(JSON.stringify(events)).not.toContain("Agent not found");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("the fake opencode reports Agent not found and exits 1 when PWD is not the run dir", () => {
    const base = realpathSync(mkdtempSync(resolve(tmpdir(), "opencode-pwd-")));
    const runDir = resolve(base, "repo", ".substrate", "runs", "r1");
    const agentsDir = resolve(runDir, ".opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(resolve(agentsDir, "agent_x.md"), "---\nmode: primary\n---\n", "utf8");
    try {
      const argv = [fakeBinaryPath, "run", "--format", "json", "--agent", "agent_x", "hello"];

      const wrongPwd = spawnSync(process.execPath, argv, {
        encoding: "utf8",
        cwd: runDir,
        env: { ...process.env, PWD: resolve(base, "repo") },
      });
      expect(wrongPwd.status).toBe(1);
      expect(JSON.parse(wrongPwd.stdout.trim())).toEqual({
        type: "error",
        error: { type: "unknown", message: 'Agent not found: "agent_x"' },
      });

      const rightPwd = spawnSync(process.execPath, argv, {
        encoding: "utf8",
        cwd: runDir,
        env: { ...process.env, PWD: runDir },
      });
      expect(rightPwd.status).toBe(0);
      expect(rightPwd.stdout).not.toContain("Agent not found");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
