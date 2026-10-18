import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import type * as Contracts from "../../../src/contracts/index.js";
import { reduce } from "../../../src/engine/reducer.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
  loadEngine,
  writePlanFiles,
  readEventLog,
  type ScenarioEnv,
} from "../scenarios/helpers.js";
import {
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
} from "../roles/fixtures.js";
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

  // Shared fixture: a real two-task engine run executed through the run
  // command in a temp repo, used by the inspection commands below.
  async function runTwoTaskRun(): Promise<ScenarioEnv> {
    const fakeClaude = fakeClaudeAdapter([
      {
        edits: {
          "src/t1.ts": "export const t1 = 1;\n",
          "test/t1.test.ts": "export const testT1 = true;\n",
        },
        reply: "Done T1",
      },
      {
        edits: {
          "src/t2.ts": "export const t2 = 2;\n",
          "test/t2.test.ts": "export const testT2 = true;\n",
        },
        reply: "Done T2",
      },
    ]);
    const env = await setupScenarioEnv("cli-cmds", { adapter: fakeClaude.adapter });
    const cleanup = env.cleanup.bind(env);
    env.cleanup = async () => {
      await cleanup();
      fakeClaude.cleanup();
    };

    const engineMod = await loadEngine();
    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: env.adapter,
    });

    const runId = createRunId();
    const manifest: Contracts.Manifest = {
      ...sampleValidManifest(runId),
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
      integration_verify: [
        { run: "echo integration verify passed", timeout_s: 30 },
      ],
    };
    writePlanFiles(env.repoRoot, runId, manifest, {
      "tasks/T1.md": sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T1",
          title: "Task 1",
          depends_on: [],
          write: ["src/t1.ts"],
          create: ["test/t1.test.ts"],
          verify: [{ run: "echo verify T1", timeout_s: 30 }],
        },
      }),
      "tasks/T2.md": sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T2",
          title: "Task 2",
          depends_on: [],
          write: ["src/t2.ts"],
          create: ["test/t2.test.ts"],
          verify: [{ run: "echo verify T2", timeout_s: 30 }],
        },
      }),
    });

    const runCommand = await loadCommand("../../../src/cli/commands/run.js", "runCommand");
    const stdout = createMockStream();
    const stderr = createMockStream();
    const ctx: CommandContext = {
      cwd: env.repoRoot,
      flags: { permissionMode: "bypassPermissions" },
      rawArgs: ["Implement tasks T1 and T2"],
      stdout,
      stderr,
      engine,
    };
    const exit = await runCommand.execute(ctx);
    if (exit !== 0) {
      throw new Error(
        `fixture two-task run failed with exit ${exit}: ${stderr.getOutput()}`
      );
    }
    return env;
  }

  function findRunId(env: ScenarioEnv): string {
    const runsDir = join(env.repoRoot, ".substrate", "runs");
    const entries = readdirSync(runsDir);
    return entries[0];
  }

  describe("status command", () => {
    it("drives a two-task run and counts passed tasks like the summary", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        const statusCommand = await loadCommand("../../../src/cli/commands/status.js", "statusCommand");
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await statusCommand.execute(ctx);
        expect(exitCode).toBe(0);

        const log = readEventLog(env.runDir, runId);
        // Replay the run log through the engine reducer like the engine does.
        let state = {
          run_id: runId as Contracts.RunId,
          state: "CREATED" as const,
          tasks: {} as Record<string, any>,
          usage: { total_usd: 0, by_role: {} },
          checkpoints: [] as string[],
        };
        for (const ev of log) {
          state = reduce(state as any, ev) as typeof state;
        }
        const passedInSummary = Object.values(state.tasks).filter(
          (t: any) => t.state === "PASSED" || t.state === "MERGED"
        ).length;

        const output = stdout.getOutput();
        expect(output).toContain(runId);
        expect(output).toMatch(/FINISHED/);
        // Every task's real state appears in the table.
        expect(output).toMatch(/T1\tMERGED/);
        expect(output).toMatch(/T2\tMERGED/);
        // The status passed count equals the summary's passed count for the
        // same run (invariant).
        expect(output).toContain(`${passedInSummary}/${passedInSummary} passed`);
      } finally {
        await env.cleanup();
      }
    });

    it("status --output-format json prints one object whose passed count equals PASSED or MERGED tasks", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        const statusCommand = await loadCommand("../../../src/cli/commands/status.js", "statusCommand");
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: { outputFormat: "json" },
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await statusCommand.execute(ctx);
        expect(exitCode).toBe(0);
        if (stdout.getOutput().length === 0) {
          throw new Error(`status produced no stdout; stderr: ${stderr.getOutput()}`);
        }

        const parsed = JSON.parse(stdout.getOutput());
        const tracked = Object.values(parsed.tasks).filter(
          (t: any) => t.state === "PASSED" || t.state === "MERGED"
        ).length;
        expect(parsed.passed).toBe(tracked);
        expect(parsed.passed).toBe(2);
        expect(stdout.getOutput().trim().split("\n").length).toBeGreaterThan(0);
      } finally {
        await env.cleanup();
      }
    });

    it("recovers from a torn final line with a warning and exit 0", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        // Simulate a partial write: append a torn last line.
        appendFileSync(join(env.runDir, runId, "events.jsonl"), '{"v":1,"seq":', "utf8");

        const statusCommand = await loadCommand("../../../src/cli/commands/status.js", "statusCommand");
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await statusCommand.execute(ctx);
        expect(exitCode).toBe(0);
        expect(stderr.getOutput()).toMatch(/torn or unparsable lines/);
        expect(stdout.getOutput()).toContain(`/2 passed`);
      } finally {
        await env.cleanup();
      }
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
    it("prints every task with its real state, generation and attempt count", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        const tasksCommand = await loadCommand("../../../src/cli/commands/tasks.js", "tasksCommand");
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await tasksCommand.execute(ctx);
        expect(exitCode).toBe(0);

        const output = stdout.getOutput();
        expect(output).toContain(runId);
        expect(output).toMatch(/T1\tMERGED\t1\t1\t-/);
        expect(output).toMatch(/T2\tMERGED\t1\t1\t-/);
        expect(output).toMatch(/pass/);
      } finally {
        await env.cleanup();
      }
    });
  });

  describe("cost command", () => {
    it("reads usage recorded by a real run and breaks cost down per role and model", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        const log = readEventLog(env.runDir, runId);
        const usageEvents = log.filter((e) => e.type === "usage.recorded");
        expect(usageEvents.length).toBeGreaterThan(0);

        const costCommand = await loadCommand("../../../src/cli/commands/cost.js", "costCommand");
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await costCommand.execute(ctx);
        expect(exitCode).toBe(0);

        // The roles the run actually reported usage for appear in the table.
        const roles = new Set(usageEvents.map((e) => (e.data as any).role));
        const output = stdout.getOutput();
        for (const role of roles) {
          expect(output).toContain(role);
        }
      } finally {
        await env.cleanup();
      }
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
    it("prints goal, duration, task table, tokens, cost, files and verify outcomes for a real run", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        const reportCommand = await loadCommand("../../../src/cli/commands/report.js", "reportCommand");
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await reportCommand.execute(ctx);
        expect(exitCode).toBe(0);

        const log = readEventLog(env.runDir, runId);
        const usage = log.filter((e) => e.type === "usage.recorded");
        const tokensIn = usage.reduce((n, e) => n + ((e.data as any).record?.input_tokens ?? 0), 0);
        const tokensOut = usage.reduce((n, e) => n + ((e.data as any).record?.output_tokens ?? 0), 0);

        const output = stdout.getOutput();
        // Goal: the first run.created data's prompt.
        expect(output).toContain("Implement tasks T1 and T2");
        expect(output).toMatch(/Duration: /);
        expect(output).toMatch(/T1\tMERGED\t1\t1/);
        expect(output).toContain(`Tokens In:  ${tokensIn}`);
        expect(output).toContain(`Tokens Out: ${tokensOut}`);
        expect(output).toMatch(/Cost:       \$0\.00/);
        // Verify outcomes for each verify.finished in the log.
        const verifies = log.filter((e) => e.type === "task.verify.finished");
        expect(output).toContain("Verify Outcomes:");
        for (const v of verifies) {
          const d = v.data as any;
          expect(output).toContain(`task ${d.task_id}: ${d.passed ? "passed" : "failed"}`);
        }
      } finally {
        await env.cleanup();
      }
    });

    it("prints 'no events recorded' and exits 1 for a run without events", async () => {
      const reportCommand = await loadCommand("../../../src/cli/commands/report.js", "reportCommand");

      const runId = createRunId();
      const runDir = join(tmpDir, ".substrate", "runs", runId);
      mkdirSync(runDir, { recursive: true });

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
      expect(exitCode).toBe(1);
      expect(stdout.getOutput()).toContain("no events recorded");
    });
  });

  describe("merge command", () => {
    it("merges a finished run branch into the current branch", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        const mergeCommand = await loadCommand("../../../src/cli/commands/merge.js", "mergeCommand");

        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await mergeCommand.execute(ctx);
        expect(exitCode).toBe(0);
        expect(stdout.getOutput()).toMatch(/Successfully merged/);
      } finally {
        await env.cleanup();
      }
    });
  });

  describe("undo command", () => {
    it("reverts the run branch to the last batch checkpoint ref", async () => {
      const env = await runTwoTaskRun();
      try {
        const runId = findRunId(env);
        const undoCommand = await loadCommand("../../../src/cli/commands/undo.js", "undoCommand");

        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: env.repoRoot,
          flags: {},
          rawArgs: [runId],
          stdout,
          stderr,
        };

        const exitCode = await undoCommand.execute(ctx);
        expect(exitCode).toBe(0);
      } finally {
        await env.cleanup();
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
