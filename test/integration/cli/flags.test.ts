import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Contracts from "../../../src/contracts/index.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Contracts.Effort;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  noGovernor?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: Contracts.PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
}

export type ParsedCliFlags = CliGlobalFlags & CliGovernanceFlags;

export interface ParseCliArgsResult {
  commandName?: string;
  flags: ParsedCliFlags;
  positional: string[];
}

export interface DispatcherModule {
  parseCliArgs: (argv: string[]) => ParseCliArgsResult;
  readStdinIfAvailable: (stdinStream?: NodeJS.ReadStream) => Promise<string | undefined>;
  runCli: (
    argv: string[],
    streams?: {
      stdin?: NodeJS.ReadStream;
      stdout?: NodeJS.WriteStream;
      stderr?: NodeJS.WriteStream;
    },
  ) => Promise<number>;
}

async function loadDispatcher(): Promise<DispatcherModule> {
  return (await import("../../../src/cli/dispatcher.js" as any)) as any;
}

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

function createMockWritable(): NodeJS.WriteStream & { getOutput: () => string; getLines: () => string[] } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as any;
  stream.isTTY = false;
  stream.columns = 80;
  stream.rows = 24;
  stream.getOutput = () => output;
  stream.getLines = () => output.split("\n").filter((l) => l.trim().length > 0);
  return stream;
}

describe("cli: flags and dispatcher", () => {
  describe("parseCliArgs() - Strict Flag Parsing", () => {
    it("parses boolean flags: -p, --print, -c, --continue, --fork-session, --no-governor, -w, --worktree, --sandbox", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res1 = parseCliArgs([
        "-p",
        "-c",
        "--fork-session",
        "--no-governor",
        "-w",
        "--sandbox",
      ]);

      expect(res1.flags.print).toBe(true);
      expect(res1.flags.continue).toBe(true);
      expect(res1.flags.forkSession).toBe(true);
      expect(res1.flags.noGovernor).toBe(true);
      expect(res1.flags.worktree).toBe(true);
      expect(res1.flags.sandbox).toBe(true);

      const res2 = parseCliArgs([
        "--print",
        "--continue",
        "--worktree",
      ]);
      expect(res2.flags.print).toBe(true);
      expect(res2.flags.continue).toBe(true);
      expect(res2.flags.worktree).toBe(true);
    });

    it("parses string flags: output-format, model, worker-model, effort, session-id, resume, mode, permission-mode, settings", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs([
        "--output-format", "stream-json",
        "--model", "claude-sonnet-5-5",
        "--worker-model", "claude-haiku-4-5",
        "--effort", "high",
        "--session-id", "sess_custom_123",
        "--resume", "r_ABCDEF123456",
        "--mode", "solo",
        "--permission-mode", "acceptEdits",
        "--settings", "./custom-settings.json",
        "--max-budget-usd", "15.5",
        "--timeout", "45",
      ]);

      expect(res.flags.outputFormat).toBe("stream-json");
      expect(res.flags.model).toBe("claude-sonnet-5-5");
      expect(res.flags.workerModel).toBe("claude-haiku-4-5");
      expect(res.flags.effort).toBe("high");
      expect(res.flags.sessionId).toBe("sess_custom_123");
      expect(res.flags.resume).toBe("r_ABCDEF123456");
      expect(res.flags.mode).toBe("solo");
      expect(res.flags.permissionMode).toBe("acceptEdits");
      expect(res.flags.settings).toBe("./custom-settings.json");
      expect(res.flags.maxBudgetUsd).toBe(15.5);
      expect(res.flags.timeout).toBe(45);
    });

    it("parses array flags: --allowed-tools, --disallowed-tools", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs([
        "--allowed-tools", "Bash",
        "--allowed-tools", "FileRead(*)",
        "--disallowed-tools", "Bash(git push*)",
        "--disallowed-tools", "WebFetch",
      ]);

      expect(res.flags.allowedTools).toEqual(["Bash", "FileRead(*)"]);
      expect(res.flags.disallowedTools).toEqual(["Bash(git push*)", "WebFetch"]);
    });
  });

  describe("Command Resolution", () => {
    it("resolves first positional argument when matching a known subcommand and shifts positional args", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const subcommands = [
        "run", "plan", "resume", "status", "tasks", "cost", "report",
        "verify", "merge", "undo", "discard", "models", "agents",
        "backends", "sessions", "config", "doctor", "init",
      ];

      for (const cmd of subcommands) {
        const res = parseCliArgs([cmd, "arg1", "arg2"]);
        expect(res.commandName).toBe(cmd);
        expect(res.positional).toEqual(["arg1", "arg2"]);
      }
    });

    it("defaults to 'run' command when -p or --print is specified", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["-p", "implement new feature"]);
      expect(res.commandName).toBe("run");
      expect(res.positional).toEqual(["implement new feature"]);
      expect(res.flags.print).toBe(true);
    });

    it("defaults to 'run' command when first arg is not a command but prompt text is given", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["refactor auth flow to use jwt"]);
      expect(res.commandName).toBe("run");
      expect(res.positional).toEqual(["refactor auth flow to use jwt"]);
    });
  });

  describe("runCli() - Help Text & Dispatch Routing", () => {
    it("displays help and available subcommands and exits 0 when no args provided on TTY stdin", async () => {
      const { runCli } = await loadDispatcher();

      const stdin = createMockReadable("", true); // isTTY = true
      const stdout = createMockWritable();
      const stderr = createMockWritable();

      const exitCode = await runCli([], { stdin, stdout, stderr });

      expect(exitCode).toBe(0);
      const out = stdout.getOutput();
      expect(out).toMatch(/Substrate/i);
      expect(out).toMatch(/run/);
      expect(out).toMatch(/plan/);
      expect(out).toMatch(/doctor/);
    });

    it("treats an unknown first word as a run prompt instead of an error", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const parsed = parseCliArgs(["unknown-command-xyz", "--some-flag"]);

      expect(parsed.commandName).toBe("run");
      expect(parsed.positional).toEqual(["unknown-command-xyz"]);
    });

    it("enforces mutual exclusivity between --continue and --resume, exiting with code 2", async () => {
      const { runCli } = await loadDispatcher();

      const stdout = createMockWritable();
      const stderr = createMockWritable();

      const exitCode = await runCli(
        ["run", "--continue", "--resume", "r_ABCDEF123456", "some prompt"],
        { stdout, stderr },
      );

      expect(exitCode).toBe(2);
      expect(stderr.getOutput()).toMatch(/mutually exclusive|conflict/i);
    });

    it("run --model --worker-model in a temp repo exits with a code other than 2 (C-H18)", async () => {
      const { runCli } = await loadDispatcher();
      const dir = mkdtempSync(join(tmpdir(), "substrate-flags-"));
      try {
        execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
        const prevCwd = process.cwd();
        process.chdir(dir);
        try {
          const stdin = createMockReadable("", true);
          const stdout = createMockWritable();
          const stderr = createMockWritable();

          const exitCode = await runCli(["run", "--model", "x", "--worker-model", "y", "goal"], {
            stdin,
            stdout,
            stderr,
          });

          expect(exitCode).not.toBe(2);
        } finally {
          process.chdir(prevCwd);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });

  describe("readStdinIfAvailable() & Stdin Prompt Intake", () => {
    it("uses positional prompt if provided, taking precedence over stdin", async () => {
      const { parseCliArgs, readStdinIfAvailable } = await loadDispatcher();

      const parsed = parseCliArgs(["run", "Positional prompt text"]);
      const stdin = createMockReadable("Ignored stdin content", false);

      const stdinPrompt = await readStdinIfAvailable(stdin);
      const finalPrompt = parsed.positional[0] ?? stdinPrompt;

      expect(finalPrompt).toBe("Positional prompt text");
    });

    it("reads complete UTF-8 stream from non-TTY stdin when positional prompt is absent", async () => {
      const { readStdinIfAvailable } = await loadDispatcher();

      const stdin = createMockReadable("Piped prompt from cat or echo\n", false);
      const prompt = await readStdinIfAvailable(stdin);

      expect(prompt).toBe("Piped prompt from cat or echo");
    });

    it("returns exit code 2 when command requires prompt and non-TTY stdin is empty", async () => {
      const { runCli } = await loadDispatcher();

      const stdin = createMockReadable("   \n\t  ", false); // Whitespace only
      const stdout = createMockWritable();
      const stderr = createMockWritable();

      const exitCode = await runCli(["run"], { stdin, stdout, stderr });

      expect(exitCode).toBe(2);
      expect(stderr.getOutput()).toMatch(/prompt required/i);
    });

    it("returns exit code 2 when command requires prompt and stdin is a TTY without prompt", async () => {
      const { runCli } = await loadDispatcher();

      const stdin = createMockReadable("", true); // TTY stdin
      const stdout = createMockWritable();
      const stderr = createMockWritable();

      // run with no positional prompt on TTY should exit 2 immediately and never hang
      const exitCode = await runCli(["plan"], { stdin, stdout, stderr });

      expect(exitCode).toBe(2);
      expect(stderr.getOutput()).toMatch(/prompt required/i);
    });
  });
});
