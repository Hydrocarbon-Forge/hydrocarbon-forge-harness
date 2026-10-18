import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";

function createMockReadable(content?: string, isTTY = false): NodeJS.ReadStream {
  const stream = new Readable({
    read() {
      if (content !== undefined) {
        this.push(Buffer.from(content, "utf8"));
      }
      this.push(null);
    },
  }) as any;
  stream.isTTY = isTTY;
  return stream;
}

function createMockWritable(): NodeJS.WriteStream & { getOutput: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as any;
  stream.isTTY = false;
  stream.getOutput = () => output;
  return stream;
}

async function loadDispatcher(): Promise<{
  runCli: (
    argv: string[],
    streams?: {
      stdin?: NodeJS.ReadStream;
      stdout?: NodeJS.WriteStream;
      stderr?: NodeJS.WriteStream;
    },
  ) => Promise<number>;
}> {
  return (await import("../../../src/cli/dispatcher.js" as any)) as any;
}

function seedFinishedRun(cwd: string, runId: string): void {
  const runDir = join(cwd, ".substrate", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ type: "run.finished", data: { status: "finished" } }) + "\n",
  );
}

function seedWorktree(cwd: string, runId: string, taskId: string): void {
  mkdirSync(join(cwd, ".substrate", "worktrees", runId, taskId), { recursive: true });
}

function seedSession(cwd: string, sessionId: string, runs: string[]): void {
  const dir = join(cwd, ".substrate", "sessions");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      createdAt: now,
      updatedAt: now,
      mode: "auto",
      prompts: [],
      runs,
    }),
  );
}

describe("cli: run-control flags (R1.8)", () => {
  let cwd: string;
  let homeDir: string;
  let configDir: string;
  let prevCwd: string;
  let prevHome: string | undefined;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "substrate-rc-"));
    homeDir = mkdtempSync(join(tmpdir(), "substrate-rc-home-"));
    configDir = mkdtempSync(join(tmpdir(), "substrate-rc-cfg-"));
    prevCwd = process.cwd();
    prevHome = process.env.HOME;
    prevConfigDir = process.env.SUBSTRATE_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.SUBSTRATE_CONFIG_DIR = configDir;
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    process.env.SUBSTRATE_CONFIG_DIR = prevConfigDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("resume <id> with an id matching neither a run nor a session exits 2 with the recorded error", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["resume", "no_such_id_123"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: no run or session matches 'no_such_id_123'");
    expect(stdout.getOutput()).toBe("");
  });

  it("resume --session-id <id> is accepted as the same selector when no positional is given", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["resume", "--session-id", "no_such_id_123"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: no run or session matches 'no_such_id_123'");
  });

  it("run --resume <id> runs the same code path as resume <id>", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(
      ["run", "--resume", "no_such_id_123", "some prompt"],
      { stdin: createMockReadable("", true), stdout, stderr },
    );

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: no run or session matches 'no_such_id_123'");
  });

  it("run --resume <run_id> resolves the run first and reports a finished run as already finished", async () => {
    const { runCli } = await loadDispatcher();
    seedFinishedRun(cwd, "r_RC_TEST123456");

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(
      ["run", "--resume", "r_RC_TEST123456", "some prompt"],
      { stdin: createMockReadable("", true), stdout, stderr },
    );

    expect(code).toBe(0);
    expect(stdout.getOutput()).toMatch(/already finished/);
  });

  it("resume <session_id> with no runs to resume exits 2 with the recorded error", async () => {
    const { runCli } = await loadDispatcher();
    seedSession(cwd, "sess_no_runs", []);

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["resume", "sess_no_runs"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: session sess_no_runs has no runs to resume");
  });

  it("-c with no session exits 2 with the recorded error", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["run", "-c", "some prompt"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: no session to continue");
  });

  it("--fork-session without --resume or -c exits 2 with the recorded error", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["run", "--fork-session", "some prompt"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: --fork-session requires --resume or --continue");
  });

  it("verify <task> with no worktree for the task exits 2 with the recorded error (no fallback to another task)", async () => {
    const { runCli } = await loadDispatcher();
    seedWorktree(cwd, "r_RC_OTHER123", "some_other_task");

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["verify", "my_task"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: no worktree for task my_task in run unknown");
    expect(stdout.getOutput()).toBe("");
  });

  it("verify <task> --run <id> without a worktree in that run exits 2 with the recorded error", async () => {
    const { runCli } = await loadDispatcher();
    seedWorktree(cwd, "r_RC_OTHER123", "my_task");

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["verify", "my_task", "--run", "r_RC_MISSING99"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: no worktree for task my_task in run r_RC_MISSING99");
  });

  it("verify <task> --timeout 0 is treated as no override and still resolves the worktree", async () => {
    const { runCli } = await loadDispatcher();
    seedWorktree(cwd, "r_RC_TIMEOUT12", "my_task");

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    // No spec file in the worktree: zero commands, so the run passes trivially.
    const code = await runCli(["verify", "my_task", "--timeout", "0"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
  });

  it("agents import without --from exits 2 with the recorded error", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["agents", "import"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: --from is required");
  });

  it("agents import --from <other> exits 2 with the recorded error", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["agents", "import", "--from", "gemini"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(2);
    expect(stderr.getOutput()).toMatch("Error: --from must be claude or opencode");
  });

  it("agents import --help prints usage and exits 0", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["agents", "import", "--help"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.getOutput()).toMatch(/Substrate/i);
    expect(stdout.getOutput()).toMatch(/Available Commands/);
  });

  it("bench --help prints usage and exits 0", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["bench", "--help"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(stdout.getOutput()).toMatch(/Substrate/i);
    expect(stdout.getOutput()).toMatch(/bench/);
  });

  it("sessions --output-format json prints exactly one JSON object to stdout", async () => {
    const { runCli } = await loadDispatcher();
    seedSession(cwd, "sess_json_test", ["r_RC_JSON12345"]);

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["sessions", "--output-format", "json"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    const lines = stdout.getOutput().split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.map((s: any) => s.id)).toContain("sess_json_test");
  });

  it("backends --output-format json prints exactly one JSON object to stdout", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["backends", "--output-format", "json"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    const lines = stdout.getOutput().split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(Array.isArray(parsed.backends)).toBe(true);
    expect(parsed.backends.length).toBeGreaterThan(0);
    expect(parsed.capabilities).toBeTypeOf("object");
  });

  it("doctor --output-format json prints exactly one JSON object to stdout", async () => {
    const { runCli } = await loadDispatcher();

    const stdout = createMockWritable();
    const stderr = createMockWritable();

    const code = await runCli(["doctor", "--output-format", "json"], {
      stdin: createMockReadable("", true),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    const lines = stdout.getOutput().split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.node).toBeTypeOf("object");
    expect(parsed.git).toBeTypeOf("object");
  });
});
