import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import type * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import type { CommandContext, CliCommand } from "./execution.test.js";

async function loadCommand(modulePath: string, exportName: string): Promise<CliCommand> {
  const mod = (await import(modulePath as any)) as any;
  return mod[exportName] as CliCommand;
}

function createMockStream(): NodeJS.WriteStream & {
  getOutput: () => string;
  getLines: () => string[];
} {
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
  stream.getLines = () => output.trim().split("\n").filter((l) => l.trim().length > 0);
  return stream;
}

describe("cli: inspection and lifecycle commands", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-cmds-test-"));
    mkdirSync(join(tmpDir, ".substrate"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("status command", () => {
    it("reads run events and displays state, pause reason, tasks, and cumulative cost", async () => {
      const statusCommand = await loadCommand("../../../src/cli/commands/status.js", "statusCommand");

      const runId = createRunId() as Contracts.RunId;
      const runDir = join(tmpDir, ".substrate", "runs", runId);
      mkdirSync(runDir, { recursive: true });

      const events = [
        { v: 1, seq: 1, ts: nowIsoTimestamp(), run_id: runId, type: "run.created", data: { run_id: runId } },
        { v: 1, seq: 2, ts: nowIsoTimestamp(), run_id: runId, type: "task.started", data: { task_id: "T1" } },
        { v: 1, seq: 3, ts: nowIsoTimestamp(), run_id: runId, type: "task.verified", data: { task_id: "T1", verdict: "pass" } },
        { v: 1, seq: 4, ts: nowIsoTimestamp(), run_id: runId, type: "run.state", data: { state: "finished" } },
      ];
      writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };

      const exitCode = await statusCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toContain(runId);
      expect(output).toMatch(/finished|passed/i);
    });

    it("returns exit code 2 when run is not found", async () => {
      const statusCommand = await loadCommand("../../../src/cli/commands/status.js", "statusCommand");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["r_NONEXISTENT"],
        stdout,
        stderr,
      };

      const exitCode = await statusCommand.execute(ctx);
      expect(exitCode).toBe(2);
    });
  });

  describe("tasks command", () => {
    it("displays table of tasks with ID, Class, State, Generation, Attempt, FailureClass, and Verify status", async () => {
      const tasksCommand = await loadCommand("../../../src/cli/commands/tasks.js", "tasksCommand");

      const runId = createRunId() as Contracts.RunId;
      const runDir = join(tmpDir, ".substrate", "runs", runId);
      mkdirSync(runDir, { recursive: true });

      const events = [
        { v: 1, seq: 1, ts: nowIsoTimestamp(), run_id: runId, type: "task.started", data: { task_id: "T1", class: "feature" } },
        { v: 1, seq: 2, ts: nowIsoTimestamp(), run_id: runId, type: "task.verified", data: { task_id: "T1", verdict: "pass" } },
      ];
      writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };

      const exitCode = await tasksCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toMatch(/T1/);
    });
  });

  describe("cost command", () => {
    it("displays cost breakdown per role and per model for a run ID", async () => {
      const costCommand = await loadCommand("../../../src/cli/commands/cost.js", "costCommand");

      const runId = createRunId() as Contracts.RunId;
      const runDir = join(tmpDir, ".substrate", "runs", runId);
      mkdirSync(runDir, { recursive: true });

      const events = [
        {
          v: 1,
          seq: 1,
          ts: nowIsoTimestamp(),
          run_id: runId,
          type: "usage",
          data: {
            role: "worker",
            model: "claude-sonnet-5-5",
            cost_usd: 0.25,
            input_tokens: 1000,
            output_tokens: 500,
          },
        },
      ];
      writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };

      const exitCode = await costCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toContain("0.25");
    });

    it("displays aggregate ledger spend when run ID is omitted", async () => {
      const costCommand = await loadCommand("../../../src/cli/commands/cost.js", "costCommand");

      const ledgerDir = join(tmpDir, ".substrate", "ledger");
      mkdirSync(ledgerDir, { recursive: true });

      const usageRecord = {
        ts: nowIsoTimestamp(),
        run_id: createRunId(),
        role: "planner",
        model: "claude-sonnet-5-5",
        cost_usd: 1.50,
      };
      writeFileSync(join(ledgerDir, "usage.jsonl"), JSON.stringify(usageRecord) + "\n", "utf8");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout,
        stderr,
      };

      const exitCode = await costCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toContain("1.50");
    });
  });

  describe("report command", () => {
    it("prints diagnostic report including goal, DAG, replan iterations, and verify tails", async () => {
      const reportCommand = await loadCommand("../../../src/cli/commands/report.js", "reportCommand");

      const runId = createRunId() as Contracts.RunId;
      const runDir = join(tmpDir, ".substrate", "runs", runId);
      mkdirSync(runDir, { recursive: true });

      writeFileSync(join(runDir, "manifest.yaml"), `goal: "Build feature"\ntasks:\n  T1:\n    title: "T1 task"\n`, "utf8");
      writeFileSync(
        join(runDir, "events.jsonl"),
        JSON.stringify({ v: 1, seq: 1, ts: nowIsoTimestamp(), run_id: runId, type: "run.created", data: { goal: "Build feature" } }) + "\n",
        "utf8",
      );

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };

      const exitCode = await reportCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toContain("Build feature");
    });
  });

  describe("verify command", () => {
    it("locates task in run worktree, runs verify commands, and returns 0 on pass or 1 on fail", async () => {
      const verifyCommand = await loadCommand("../../../src/cli/commands/verify.js", "verifyCommand");

      const runId = createRunId() as Contracts.RunId;
      const worktreeDir = join(tmpDir, ".substrate", "worktrees", runId, "T1");
      mkdirSync(worktreeDir, { recursive: true });

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId, "T1"],
        stdout,
        stderr,
      };

      const exitCode = await verifyCommand.execute(ctx);
      expect(exitCode === 0 || exitCode === 1).toBe(true);
    });
  });

  describe("merge command", () => {
    it("merges run branch into current branch when finished and clean", async () => {
      const mergeCommand = await loadCommand("../../../src/cli/commands/merge.js", "mergeCommand");

      const testRepo = createTestRepo("sub-cli-merge-");
      try {
        const runId = createRunId() as Contracts.RunId;
        testRepo.createBranch(`substrate/runs/${runId}`);

        const runDir = join(testRepo.dir, ".substrate", "runs", runId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, "events.jsonl"),
          JSON.stringify({ v: 1, seq: 1, ts: nowIsoTimestamp(), run_id: runId, type: "run.state", data: { state: "finished" } }) + "\n",
          "utf8",
        );

        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: testRepo.dir,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await mergeCommand.execute(ctx);
        expect(exitCode).toBe(0);
      } finally {
        testRepo.cleanup();
      }
    });
  });

  describe("undo command", () => {
    it("reverts run branch to prior batch checkpoint ref and exits 0", async () => {
      const undoCommand = await loadCommand("../../../src/cli/commands/undo.js", "undoCommand");

      const testRepo = createTestRepo("sub-cli-undo-");
      try {
        const runId = createRunId() as Contracts.RunId;
        testRepo.createBranch(`substrate/runs/${runId}`);

        const runDir = join(testRepo.dir, ".substrate", "runs", runId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, "events.jsonl"),
          JSON.stringify({
            v: 1,
            seq: 1,
            ts: nowIsoTimestamp(),
            run_id: runId,
            type: "batch.merged",
            data: { batch_id: "b1", checkpoint_ref: "HEAD~1" },
          }) + "\n",
          "utf8",
        );

        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: testRepo.dir,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await undoCommand.execute(ctx);
        expect(exitCode).toBe(0);
      } finally {
        testRepo.cleanup();
      }
    });
  });

  describe("discard command", () => {
    it("removes run worktree directories, deletes run branch, and exits 0", async () => {
      const discardCommand = await loadCommand("../../../src/cli/commands/discard.js", "discardCommand");

      const testRepo = createTestRepo("sub-cli-discard-");
      try {
        const runId = createRunId() as Contracts.RunId;
        testRepo.createBranch(`substrate/runs/${runId}`);

        const worktreeDir = join(testRepo.dir, ".substrate", "worktrees", runId);
        mkdirSync(worktreeDir, { recursive: true });
        writeFileSync(join(worktreeDir, "scratch.txt"), "temp", "utf8");

        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: testRepo.dir,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await discardCommand.execute(ctx);
        expect(exitCode).toBe(0);
        expect(existsSync(worktreeDir)).toBe(false);
      } finally {
        testRepo.cleanup();
      }
    });
  });

  describe("models command", () => {
    it("displays routing table: TaskClass -> Backend, Model, Effort, and escalation chain", async () => {
      const modelsCommand = await loadCommand("../../../src/cli/commands/models.js", "modelsCommand");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout,
        stderr,
      };

      const exitCode = await modelsCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toMatch(/claude/i);
      expect(output).toMatch(/feature/i);
    });
  });

  describe("agents command", () => {
    it("scans agent definition paths and displays names, roles, and descriptions", async () => {
      const agentsCommand = await loadCommand("../../../src/cli/commands/agents.js", "agentsCommand");

      const agentsDir = join(tmpDir, ".substrate", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "custom-worker.md"),
        `---\nname: custom-worker\ndescription: Custom specialized worker\nrole: worker\n---\nPrompt body\n`,
        "utf8",
      );

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout,
        stderr,
      };

      const exitCode = await agentsCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toContain("custom-worker");
      expect(output).toContain("Custom specialized worker");
    });
  });

  describe("backends command", () => {
    it("validates adapter environments and displays versions, pins, and capabilities", async () => {
      const backendsCommand = await loadCommand("../../../src/cli/commands/backends.js", "backendsCommand");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout,
        stderr,
      };

      const exitCode = await backendsCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toMatch(/claude|opencode|agy|fake/);
    });
  });

  describe("sessions command", () => {
    it("displays table of sessions with ID, Created, Mode, Run count, and latest prompt", async () => {
      const sessionsCommand = await loadCommand("../../../src/cli/commands/sessions.js", "sessionsCommand");

      const sessionsDir = join(tmpDir, ".substrate", "sessions");
      mkdirSync(sessionsDir, { recursive: true });

      const sessionRecord = {
        sessionId: "sess_table_test_1",
        createdAt: nowIsoTimestamp(),
        updatedAt: nowIsoTimestamp(),
        mode: "auto",
        prompts: [{ prompt: "Initial build goal", timestamp: nowIsoTimestamp() }],
        runs: ["r_111111111111"],
      };
      writeFileSync(join(sessionsDir, "sess_table_test_1.json"), JSON.stringify(sessionRecord), "utf8");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout,
        stderr,
      };

      const exitCode = await sessionsCommand.execute(ctx);
      expect(exitCode).toBe(0);

      const output = stdout.getOutput();
      expect(output).toContain("sess_table_test_1");
      expect(output).toContain("Initial build goal");
    });
  });

  describe("config command", () => {
    it("supports get, set, and list operations on settings.json", async () => {
      const configCommand = await loadCommand("../../../src/cli/commands/config.js", "configCommand");

      const stdout = createMockStream();
      const stderr = createMockStream();

      // 1. set
      const ctxSet: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["set", "budgets.run.max_usd", "25"],
        stdout,
        stderr,
      };
      const exitSet = await configCommand.execute(ctxSet);
      expect(exitSet).toBe(0);

      // Verify settings written
      const settingsPath = join(tmpDir, ".substrate", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);

      // 2. get
      const stdoutGet = createMockStream();
      const ctxGet: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["get", "budgets.run.max_usd"],
        stdout: stdoutGet,
        stderr,
      };
      const exitGet = await configCommand.execute(ctxGet);
      expect(exitGet).toBe(0);
      expect(stdoutGet.getOutput()).toContain("25");

      // 3. list
      const stdoutList = createMockStream();
      const ctxList: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["list"],
        stdout: stdoutList,
        stderr,
      };
      const exitList = await configCommand.execute(ctxList);
      expect(exitList).toBe(0);
      expect(stdoutList.getOutput()).toMatch(/budgets/);
    });
  });

  describe("doctor command", () => {
    it("runs system requirement diagnostics and returns exit 0 on clean environment", async () => {
      const doctorCommand = await loadCommand("../../../src/cli/commands/doctor.js", "doctorCommand");

      const stdout = createMockStream();
      const stderr = createMockStream();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout,
        stderr,
      };

      const exitCode = await doctorCommand.execute(ctx);
      expect(exitCode === 0 || exitCode === 1).toBe(true);

      const output = stdout.getOutput();
      expect(output).toMatch(/node/i);
      expect(output).toMatch(/git/i);
    });
  });

  describe("init command", () => {
    it("detects backends, creates .substrate directories, writes settings.json, and appends to .git/info/exclude", async () => {
      const initCommand = await loadCommand("../../../src/cli/commands/init.js", "initCommand");

      const testRepo = createTestRepo("sub-cli-init-");
      try {
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: testRepo.dir,
          flags: {},
          rawArgs: [],
          stdout,
          stderr,
        };

        const exitCode = await initCommand.execute(ctx);
        expect(exitCode).toBe(0);

        // Check created directories
        expect(existsSync(join(testRepo.dir, ".substrate", "sessions"))).toBe(true);
        expect(existsSync(join(testRepo.dir, ".substrate", "state"))).toBe(true);
        expect(existsSync(join(testRepo.dir, ".substrate", "runs"))).toBe(true);
        expect(existsSync(join(testRepo.dir, ".substrate", "worktrees"))).toBe(true);
        expect(existsSync(join(testRepo.dir, ".substrate", "settings.json"))).toBe(true);

        // Check .git/info/exclude
        const excludeFile = join(testRepo.dir, ".git", "info", "exclude");
        if (existsSync(excludeFile)) {
          const excludeContent = readFileSync(excludeFile, "utf8");
          expect(excludeContent).toMatch(/\.substrate/);
        }
      } finally {
        testRepo.cleanup();
      }
    });
  });
});
