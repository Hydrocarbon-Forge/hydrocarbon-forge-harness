import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  type SpawnRequest,
  EnvReport,
  BackendEvent,
  SessionResult,
} from "../../../src/contracts/index.js";
import { runAdapterConformanceSuite } from "../../conformance/index.js";
import { ClaudeAdapter } from "../../../src/backends/adapters/claude.js";

const here = dirname(fileURLToPath(import.meta.url));

function createFakeClaudeBin(dir: string, version = "2.1.304"): string {
  const binPath = join(dir, `fake-claude-${Math.random().toString(36).slice(2, 8)}.mjs`);
  const fakeHarnessPath = resolve(here, "../../fixtures/fake-harness/index.ts");
  const scriptContent = `#!/usr/bin/env node
import { runFakeScenario } from "${fakeHarnessPath}";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("${version}\\n");
  process.exit(0);
}

let prompt = "";
let sessionId;
let resumeId;
let disallowedTools = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-p" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
    prompt = args[++i];
  } else if (args[i] === "--session-id" && i + 1 < args.length) {
    sessionId = args[++i];
  } else if (args[i] === "--resume" && i + 1 < args.length) {
    resumeId = args[++i];
  } else if (args[i] === "--disallowedTools" && i + 1 < args.length) {
    disallowedTools = args[++i];
  }
}
// The adapter sends the prompt on stdin when -p has no prompt argument (R13.1), as the real CLI reads it.
if (prompt === "" && !args.includes("--version") && !process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  prompt = Buffer.concat(chunks).toString("utf8");
}

let scenario = "success";
if (resumeId || prompt.startsWith("scenario:resume")) {
  scenario = "resume";
} else if (prompt.startsWith("scenario:")) {
  scenario = prompt.slice("scenario:".length);
} else if (disallowedTools.includes("Bash") || prompt.includes("soft_deny")) {
  scenario = "soft_deny";
} else if (prompt.includes("hang")) {
  scenario = "hang";
}

const config = {
  scenario,
  sessionId: resumeId ?? sessionId,
  denialTool: "Bash",
  denialReason: "Permission denied by policy",
};

const code = await runFakeScenario(config, "claude", args);
process.exit(code);
`;

  writeFileSync(binPath, scriptContent, { mode: 0o755 });
  return binPath;
}

// 1. Conformance battery
const isLive = process.env.SUBSTRATE_LIVE === "1";
let sharedTmpDir: string;
let sharedFakeBin: string;

if (!isLive) {
  sharedTmpDir = mkdtempSync(join(tmpdir(), "claude-conformance-"));
  sharedFakeBin = createFakeClaudeBin(sharedTmpDir, "2.1.304");
}

runAdapterConformanceSuite(
  isLive ? "ClaudeAdapter (live)" : "ClaudeAdapter (fake harness)",
  () => {
    const rawAdapter = isLive
      ? new ClaudeAdapter()
      : new ClaudeAdapter({ bin: sharedFakeBin });
    return {
      capabilities: rawAdapter.capabilities,
      validateEnvironment: () => rawAdapter.validateEnvironment(),
      spawn: (req: SpawnRequest) => {
        const reqWithUUID: SpawnRequest = {
          ...req,
          session: req.session ?? { id: crypto.randomUUID() },
        };
        return rawAdapter.spawn(reqWithUUID);
      },
    };
  },
  {
    live: isLive,
    maxCostUsd: 0.05,
    skipScenarios: ["resume"],
  }
);

// 2. Claude-specific adapter unit & integration tests
describe("ClaudeAdapter: Environment Validation & Process Isolation", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-adapter-test-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (sharedTmpDir) {
      rmSync(sharedTmpDir, { recursive: true, force: true });
    }
  });

  it("validates environment successfully when CLI binary matches pinned version 2.1.304", async () => {
    const fakeBin = createFakeClaudeBin(tmpDir, "2.1.304");
    const adapter = new ClaudeAdapter({ bin: fakeBin });

    const report = await adapter.validateEnvironment();
    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.pin_matches).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("reports version mismatch problem when installed CLI version differs from 2.1.304", async () => {
    const fakeBin = createFakeClaudeBin(tmpDir, "2.0.0");
    const adapter = new ClaudeAdapter({ bin: fakeBin });

    const report = await adapter.validateEnvironment();
    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.pin_matches).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.problems[0]).toContain("differs from pinned version");
  });

  it("returns ok: false when CLI binary does not exist on disk", async () => {
    const nonexistentBin = join(tmpDir, "no-such-claude-binary");
    const adapter = new ClaudeAdapter({ bin: nonexistentBin });

    const report = await adapter.validateEnvironment();
    expect(EnvReport.safeParse(report).success).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.pin_matches).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it("supports session resume with matching UUID session_id", async () => {
    const fakeBin = createFakeClaudeBin(tmpDir, "2.1.304");
    const adapter = new ClaudeAdapter({ bin: fakeBin });
    const sessionCwd = mkdtempSync(join(tmpDir, "resume-conformance-"));
    const targetSessionId = crypto.randomUUID();
    const req: SpawnRequest = {
      role: "worker",
      cwd: sessionCwd,
      prompt: "scenario:resume",
      model: "claude-haiku-5-5",
      permission: { allow: [], deny: [] },
      session: { resume: targetSessionId },
    };

    const handle = adapter.spawn(req);
    const events: BackendEvent[] = [];
    for await (const event of handle.events) {
      expect(BackendEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }

    expect(events[0].type).toBe("session.started");
    if (events[0].type === "session.started") {
      expect(events[0].session_id).toBe(targetSessionId);
    }

    const result = await handle.result();
    expect(SessionResult.safeParse(result).success).toBe(true);
    expect(result.session_id).toBe(targetSessionId);
  });

  it("persists raw stdout stream byte-for-byte to req.raw_dir/<session_id>.ndjson", async () => {
    const fakeBin = createFakeClaudeBin(tmpDir, "2.1.304");
    const adapter = new ClaudeAdapter({ bin: fakeBin });
    const sessionCwd = mkdtempSync(join(tmpDir, "raw-persist-cwd-"));
    const rawDir = mkdtempSync(join(tmpDir, "raw-persist-dir-"));

    const targetSessionId = crypto.randomUUID();
    const req: SpawnRequest = {
      role: "worker",
      cwd: sessionCwd,
      raw_dir: rawDir,
      prompt: "echo hello",
      model: "claude-haiku-5-5",
      permission: { allow: [], deny: [] },
      session: { id: targetSessionId },
    };

    const handle = adapter.spawn(req);
    const events: BackendEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    const result = await handle.result();
    expect(result.ok).toBe(true);

    const rawFilePath = join(rawDir, `${targetSessionId}.ndjson`);
    expect(existsSync(rawFilePath)).toBe(true);

    const rawContent = readFileSync(rawFilePath, "utf8");
    expect(rawContent.length).toBeGreaterThan(0);
    expect(rawContent).toContain('"type":"system"');
    expect(rawContent).toContain('"type":"result"');
    expect(rawContent).toContain(targetSessionId);

    // Verify nothing written under cwd
    expect(existsSync(join(sessionCwd, "raw"))).toBe(false);
  });

  it("does not write raw stream to disk when raw_dir is absent", async () => {
    const fakeBin = createFakeClaudeBin(tmpDir, "2.1.304");
    const adapter = new ClaudeAdapter({ bin: fakeBin });
    const sessionCwd = mkdtempSync(join(tmpDir, "raw-absent-cwd-"));

    const targetSessionId = crypto.randomUUID();
    const req: SpawnRequest = {
      role: "worker",
      cwd: sessionCwd,
      prompt: "echo hello",
      model: "claude-haiku-5-5",
      permission: { allow: [], deny: [] },
      session: { id: targetSessionId },
    };

    const handle = adapter.spawn(req);
    for await (const _ of handle.events) {
      // consume
    }
    const result = await handle.result();
    expect(result.ok).toBe(true);

    expect(existsSync(join(sessionCwd, "raw"))).toBe(false);
    expect(existsSync(join(sessionCwd, `${targetSessionId}.ndjson`))).toBe(false);
    const cwdEntries = readdirSync(sessionCwd);
    expect(cwdEntries).toEqual([]);
  });

  it("enforces structured result over exit code evaluation (Invariant I11)", async () => {
    const fakeBin = createFakeClaudeBin(tmpDir, "2.1.304");
    const adapter = new ClaudeAdapter({ bin: fakeBin });
    const sessionCwd = mkdtempSync(join(tmpDir, "result-eval-"));

    const req: SpawnRequest = {
      role: "worker",
      cwd: sessionCwd,
      prompt: "scenario:soft_deny",
      model: "claude-haiku-5-5",
      session: { id: crypto.randomUUID() },
      permission: { allow: [], deny: ["Bash"] },
    };

    const handle = adapter.spawn(req);
    for await (const _ of handle.events) {
      // consume stream
    }
    const result = await handle.result();

    // Even though process exited 0 in dontAsk mode, result must accurately reflect structured denial
    expect(SessionResult.safeParse(result).success).toBe(true);
    expect(result.denials.length).toBeGreaterThan(0);
    expect(result.denials[0].tool).toBe("Bash");
  });
});
