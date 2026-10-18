import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ParseCliArgsResult {
  commandName?: string;
  flags: Record<string, any>;
  positional: string[];
}

interface DispatcherModule {
  parseCliArgs: (argv: string[]) => ParseCliArgsResult;
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

describe("R1.6: dispatch rules", () => {
  describe("parseCliArgs() - a first word that is not a command is a run prompt", () => {
    it("treats a single unknown first word as a run prompt", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["refactor"]);
      expect(res.commandName).toBe("run");
      expect(res.positional).toEqual(["refactor"]);
    });

    it("returns no command and no positional for an empty argv", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs([]);
      expect(res.commandName).toBeUndefined();
      expect(res.positional).toEqual([]);
    });

    it("defaults to run when -p is given with no positional", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["-p"]);
      expect(res.commandName).toBe("run");
    });

    it("resolves config with subcommand and shifts positional args", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["config", "list"]);
      expect(res.commandName).toBe("config");
      expect(res.positional).toEqual(["list"]);
    });

    it("resolves config with no subcommand and no positional args", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["config"]);
      expect(res.commandName).toBe("config");
      expect(res.positional).toEqual([]);
    });

    it("treats an unknown first word as a run prompt instead of an error", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["unknown-command-xyz", "--some-flag"]);
      expect(res.commandName).toBe("run");
      expect(res.positional).toEqual(["unknown-command-xyz"]);
    });

    it("treats an empty first argument as a run with an empty prompt", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs([""]);
      expect(res.commandName).toBe("run");
      expect(res.positional).toEqual([""]);
    });

    it("keeps the two-plus-words rule for a multi-word prompt", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["refactor", "the", "code"]);
      expect(res.commandName).toBe("run");
      expect(res.positional).toEqual(["refactor", "the", "code"]);
    });
  });

  describe("parseCliArgs() - --local flag", () => {
    it("parses --local as flags.local", async () => {
      const { parseCliArgs } = await loadDispatcher();

      const res = parseCliArgs(["config", "set", "a", "b", "--local"]);
      expect(res.flags.local).toBe(true);
    });
  });

  describe("runCli() - no arguments at all is always help", () => {
    it("prints help and exits 0 with no args, even when stdin is not a TTY", async () => {
      const { runCli } = await loadDispatcher();

      const stdin = { isTTY: false } as any;
      const stdout = createMockWritable();
      const stderr = createMockWritable();

      const exitCode = await runCli([], { stdin, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stdout.getOutput()).toContain("Usage:");
    });
  });

  describe("runCli() - one-word prompt reaches the run command", () => {
    it("routes a one-word unknown first word to the run command", async () => {
      const { parseCliArgs } = await loadDispatcher();

      // Per the R1.6 spec, assert via parseCliArgs rather than executing the run command.
      expect(parseCliArgs(["refactor"]).commandName).toBe("run");
    });
  });

  describe("runCli() - config list prints merged settings", () => {
    let savedConfigDir: string | undefined;
    let savedProjectDir: string | undefined;
    let savedSettings: string | undefined;
    let savedHome: string | undefined;
    let fakeHome: string;

    beforeAll(() => {
      savedConfigDir = process.env.SUBSTRATE_CONFIG_DIR;
      savedProjectDir = process.env.SUBSTRATE_PROJECT_DIR;
      savedSettings = process.env.SUBSTRATE_SETTINGS;
      savedHome = process.env.HOME;
      delete process.env.SUBSTRATE_CONFIG_DIR;
      delete process.env.SUBSTRATE_PROJECT_DIR;
      delete process.env.SUBSTRATE_SETTINGS;
      fakeHome = mkdtempSync(join(tmpdir(), "substrate-dispatch-home-"));
      process.env.HOME = fakeHome;
    });

    afterAll(() => {
      if (savedConfigDir === undefined) delete process.env.SUBSTRATE_CONFIG_DIR;
      else process.env.SUBSTRATE_CONFIG_DIR = savedConfigDir;
      if (savedProjectDir === undefined) delete process.env.SUBSTRATE_PROJECT_DIR;
      else process.env.SUBSTRATE_PROJECT_DIR = savedProjectDir;
      if (savedSettings === undefined) delete process.env.SUBSTRATE_SETTINGS;
      else process.env.SUBSTRATE_SETTINGS = savedSettings;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(fakeHome, { recursive: true, force: true });
    });

    it("config list resolves 0 and prints JSON containing a concurrency key", async () => {
      const { runCli } = await loadDispatcher();

      const stdout = createMockWritable();
      const stderr = createMockWritable();

      const exitCode = await runCli(["config", "list"], { stdout, stderr });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.getOutput());
      expect(parsed).toHaveProperty("concurrency");
    });
  });
});
