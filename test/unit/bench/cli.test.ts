import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandContext } from "../../../src/cli/registry.js";
import { registry } from "../../../src/cli/registry.js";
import { benchCommand } from "../../../src/cli/bench.js";

function createMockContext(rawArgs: string[] = [], cwd: string = process.cwd()): {
  ctx: CommandContext;
  getStdout: () => string;
  getStderr: () => string;
} {
  let stdoutData = "";
  let stderrData = "";

  const stdout = {
    write(chunk: any) {
      stdoutData += chunk.toString();
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const stderr = {
    write(chunk: any) {
      stderrData += chunk.toString();
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  return {
    ctx: {
      cwd,
      rawArgs,
      flags: {},
      stdout,
      stderr,
    },
    getStdout: () => stdoutData,
    getStderr: () => stderrData,
  };
}

describe("CLI Subcommand registration & dispatch (P6.3 §13)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Subcommand self-registration into CLI registry", () => {
    it("registers 'bench' command into CommandRegistry with valid name and description", () => {
      expect(benchCommand).toBeDefined();
      expect(benchCommand.name).toBe("bench");
      expect(benchCommand.description).toBeTruthy();

      const registered = registry.get("bench");
      expect(registered).toBeDefined();
      expect(registered?.name).toBe("bench");
    });
  });

  describe("Option parsing and validation (exit code 2 on invalid options)", () => {
    it("returns exit code 2 and writes error to stderr when unknown flag is encountered", async () => {
      const { ctx, getStderr } = createMockContext(["--unknown-flag-xyz"], tempDir);

      const exitCode = await benchCommand.execute(ctx);

      expect(exitCode).toBe(2);
      expect(getStderr()).toMatch(/unknown|invalid.*flag|option/i);
    });

    it("returns exit code 2 when invalid arm identifier is passed to --arms", async () => {
      const { ctx, getStderr } = createMockContext(["--arms", "A,B,Z"], tempDir);

      const exitCode = await benchCommand.execute(ctx);

      expect(exitCode).toBe(2);
      expect(getStderr()).toMatch(/invalid.*arm|unknown.*arm/i);
    });

    it("returns exit code 2 when negative or zero repetitions is passed to --repetitions", async () => {
      const { ctx: ctxZero, getStderr: getStderrZero } = createMockContext(
        ["--repetitions", "0"],
        tempDir
      );
      const exitCodeZero = await benchCommand.execute(ctxZero);
      expect(exitCodeZero).toBe(2);
      expect(getStderrZero()).toMatch(/repetitions/i);

      const { ctx: ctxNeg, getStderr: getStderrNeg } = createMockContext(
        ["--repetitions", "-2"],
        tempDir
      );
      const exitCodeNeg = await benchCommand.execute(ctxNeg);
      expect(exitCodeNeg).toBe(2);
      expect(getStderrNeg()).toMatch(/repetitions/i);
    });

    it("returns exit code 2 when negative budget is passed to --max-budget", async () => {
      const { ctx, getStderr } = createMockContext(["--max-budget", "-5.00"], tempDir);

      const exitCode = await benchCommand.execute(ctx);

      expect(exitCode).toBe(2);
      expect(getStderr()).toMatch(/budget/i);
    });

    it("returns exit code 2 when invalid report format is passed to --format", async () => {
      const { ctx, getStderr } = createMockContext(["--format", "csv"], tempDir);

      const exitCode = await benchCommand.execute(ctx);

      expect(exitCode).toBe(2);
      expect(getStderr()).toMatch(/format/i);
    });
  });

  describe("Command execution, dry run, and output dispatch", () => {
    it("executes dry-run successfully returning exit code 0 and displaying planned matrix without backends", async () => {
      const fixtureDir = path.join(tempDir, "fixture");
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, "package.json"), "{}");

      const taskFile = path.join(tempDir, "task1.md");
      fs.writeFileSync(
        taskFile,
        `---
id: T01
title: "Dry Run CLI Task"
task_class: feature
repo_fixture: ${fixtureDir}
verify:
  - run: echo ok
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );

      const { ctx, getStdout } = createMockContext(
        ["--dry-run", "--tasks", taskFile, "--arms", "A,B", "--repetitions", "1"],
        tempDir
      );

      const exitCode = await benchCommand.execute(ctx);

      expect(exitCode).toBe(0);
      expect(getStdout()).toMatch(/dry.*run|planned|matrix|attempts/i);
    });

    it("writes formatted report to file when --output flag is provided", async () => {
      const fixtureDir = path.join(tempDir, "fixture");
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, "package.json"), "{}");

      const taskFile = path.join(tempDir, "task1.md");
      fs.writeFileSync(
        taskFile,
        `---
id: T01
title: "Report Task"
task_class: feature
repo_fixture: ${fixtureDir}
verify:
  - run: echo ok
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );

      const outputPath = path.join(tempDir, "output-report.md");
      const { ctx } = createMockContext(
        [
          "--dry-run",
          "--tasks",
          taskFile,
          "--format",
          "markdown",
          "--output",
          outputPath,
        ],
        tempDir
      );

      const exitCode = await benchCommand.execute(ctx);

      expect(exitCode).toBe(0);
      expect(fs.existsSync(outputPath)).toBe(true);
      const content = fs.readFileSync(outputPath, "utf8");
      expect(content).toContain("| Arm |");
    });

    it("parses model flags: --top-model, --cheap-model, --local-model", async () => {
      const fixtureDir = path.join(tempDir, "fixture");
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, "package.json"), "{}");

      const taskFile = path.join(tempDir, "task1.md");
      fs.writeFileSync(
        taskFile,
        `---
id: T01
title: "Model Override Task"
task_class: feature
repo_fixture: ${fixtureDir}
verify:
  - run: echo ok
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );

      const { ctx } = createMockContext(
        [
          "--dry-run",
          "--tasks",
          taskFile,
          "--top-model",
          "custom-top-model",
          "--cheap-model",
          "custom-cheap-model",
          "--local-model",
          "custom-local-model",
        ],
        tempDir
      );

      const exitCode = await benchCommand.execute(ctx);
      expect(exitCode).toBe(0);
    });

    it("returns exit code 1 and writes error to stderr on fatal execution error", async () => {
      // Non-existent task path without dry run or invalid state leading to fatal error
      const { ctx, getStderr } = createMockContext(
        ["--tasks", path.join(tempDir, "nonexistent-task-file.md")],
        tempDir
      );

      const exitCode = await benchCommand.execute(ctx);

      expect(exitCode).toBe(1);
      expect(getStderr()).toBeTruthy();
    });
  });
});
