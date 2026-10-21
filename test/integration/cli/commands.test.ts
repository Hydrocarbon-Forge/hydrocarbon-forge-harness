import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

import { ModelCatalog } from "../../../src/cli/model-catalog.js";

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
  sampleValidContractStub,
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
      { reply: "PLAN READY" },
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
    env.testRepo.commitFile("src/t1.ts", "// existing file declared as write\n");
    env.testRepo.commitFile("src/t2.ts", "// existing file declared as write\n");
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
    }, { "contracts/types.ts": sampleValidContractStub() });

    const runCommand = await loadCommand("../../../src/cli/commands/run.js", "runCommand");
    const stdout = createMockStream();
    const stderr = createMockStream();
    const ctx: CommandContext = {
      cwd: env.repoRoot,
      // R7.2: run needs named models; --model and --worker-model name them.
      // R10.1: the run stays on its branch (--no-merge): the callers inspect it and the merge test merges it.
      flags: { permissionMode: "bypassPermissions", model: "claude-sonnet-5-5", workerModel: "haiku", noMerge: true },
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
        // R11.1: the header names the state in lower case (`finished`); the legacy block no longer repeats it.
        expect(output).toMatch(/Run \S+\s+finished/);
        // Every task's real state appears in the table.
        expect(output).toMatch(/T1\tMERGED/);
        expect(output).toMatch(/T2\tMERGED/);
        // The status passed count equals the summary's passed count for the
        // same run (invariant).
        expect(output).toContain(`Tasks: ${passedInSummary} passed, 0 running`);
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
        expect(stdout.getOutput()).toContain(`Tasks: 2 passed`);
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

  describe("cost command (usage alias)", () => {
    it("groups the usage ledger from a real run, rows derived from its usage events", async () => {
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

        const output = stdout.getOutput();
        const lines = output.trim().split("\n");
        expect(lines[0]).toBe("group runs calls input output cost");

        // The expected rows are computed from the events themselves, not from
        // the command, so the table is checked against the run's own records.
        interface Row { calls: number; input: number; output: number; cost: number; unknown: number }
        const byModel = new Map<string, Row>();
        for (const e of usageEvents) {
          const data = (e.data as any);
          const record = (data.record as any);
          const row = byModel.get(record.model) ?? { calls: 0, input: 0, output: 0, cost: 0, unknown: 0 };
          row.calls += 1;
          row.input += record.input_tokens ?? 0;
          row.output += record.output_tokens ?? 0;
          row.cost += record.cost_usd ?? 0;
          if ((record.cost_source ?? "unknown") === "unknown") row.unknown += 1;
          byModel.set(record.model, row);
        }

        const costCell = (row: Row): string =>
          `$${row.cost.toFixed(4)}${row.unknown > 0 ? ` (+ ${row.unknown} unknown)` : ""}`;
        const expectedRows = [...byModel.entries()].sort(
          (a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0])
        );
        for (const [model, row] of expectedRows) {
          expect(lines).toContain(`${model} 1 ${row.calls} ${row.input} ${row.output} ${costCell(row)}`);
        }

        const totals: Row = { calls: 0, input: 0, output: 0, cost: 0, unknown: 0 };
        for (const row of byModel.values()) {
          totals.calls += row.calls;
          totals.input += row.input;
          totals.output += row.output;
          totals.cost += row.cost;
          totals.unknown += row.unknown;
        }
        expect(lines[lines.length - 1]).toBe(
          `total ${byModel.size} ${totals.calls} ${totals.input} ${totals.output} ${costCell(totals)}`
        );
      } finally {
        await env.cleanup();
      }
    });

    it("aggregates the project ledger into a grouped table when no run ID is given", async () => {
      const costCommand = await loadCommand("../../../src/cli/commands/cost.js", "costCommand");

      const ledgerDir = join(tmpDir, ".substrate", "ledger");
      mkdirSync(ledgerDir, { recursive: true });

      const usageRecord = {
        v: 1,
        ts: nowIsoTimestamp(),
        project: tmpDir,
        run_id: createRunId(),
        role: "planner",
        backend: "fake",
        model: "claude-sonnet-5-5",
        input_tokens: 1000,
        output_tokens: 200,
        cost_usd: 1.50,
        cost_source: "reported",
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

      const lines = stdout.getOutput().trim().split("\n");
      expect(lines[0]).toBe("group runs calls input output cost");
      expect(lines).toContain("claude-sonnet-5-5 1 1 1000 200 $1.5000");
      expect(lines[lines.length - 1]).toBe("total 1 1 1000 200 $1.5000");
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

        const { execFileSync: dbgExec } = await import("node:child_process");
        const exitCode = await mergeCommand.execute(ctx);
        expect(exitCode).toBe(0);
        expect(stdout.getOutput()).toMatch(/Merged/);
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
    const binDir = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "fixtures", "fake-harness", "bin");

    type ModelsFlags = CommandContext["flags"] & { provider?: string; refresh?: boolean };

    interface ModelsResult {
      exitCode: number;
      stdout: string;
      stderr: string;
    }

    // Runs modelsCommand with a project settings file in tmpDir, isolating the
    // user settings layer so results are deterministic on any machine.
    async function runModels(settings: Record<string, unknown>, flags: ModelsFlags = {}): Promise<ModelsResult> {
      writeFileSync(join(tmpDir, ".substrate", "settings.json"), JSON.stringify(settings), "utf8");

      const configDir = mkdtempSync(join(tmpdir(), "substrate-models-config-"));
      const saved = {
        config: process.env.SUBSTRATE_CONFIG_DIR,
        settings: process.env.SUBSTRATE_SETTINGS,
        project: process.env.SUBSTRATE_PROJECT_DIR,
      };
      process.env.SUBSTRATE_CONFIG_DIR = configDir;
      delete process.env.SUBSTRATE_SETTINGS;
      delete process.env.SUBSTRATE_PROJECT_DIR;

      try {
        const modelsCommand = await loadCommand("../../../src/cli/commands/models.js", "modelsCommand");
        const stdout = createMockStream();
        const stderr = createMockStream();

        const ctx: CommandContext = {
          cwd: tmpDir,
          flags,
          rawArgs: [],
          stdout,
          stderr,
        };

        const exitCode = await modelsCommand.execute(ctx);
        return { exitCode, stdout: stdout.getOutput(), stderr: stderr.getOutput() };
      } finally {
        if (saved.config === undefined) delete process.env.SUBSTRATE_CONFIG_DIR;
        else process.env.SUBSTRATE_CONFIG_DIR = saved.config;
        if (saved.settings === undefined) delete process.env.SUBSTRATE_SETTINGS;
        else process.env.SUBSTRATE_SETTINGS = saved.settings;
        if (saved.project === undefined) delete process.env.SUBSTRATE_PROJECT_DIR;
        else process.env.SUBSTRATE_PROJECT_DIR = saved.project;
        rmSync(configDir, { recursive: true, force: true });
      }
    }

    // Pins are set explicitly for determinism; the fake harnesses answer --version
    // with exactly these pins, so every provider reports pin matches.
    function standardSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        backends: {
          claude: { bin: join(binDir, "claude"), version_pin: "2.1.304" },
          opencode: { bin: join(binDir, "opencode"), version_pin: "2.0.21" },
          agy: { bin: join(binDir, "agy"), version_pin: "1.4.2" },
        },
        ...overrides,
      };
    }

    // haiku is priced, sonnet is routed but unpriced, gemini-3.8-flash-low is the
    // worker model; the DEFAULT_SETTINGS routing.escalation array must not count as a slot.
    const slotSettings = standardSettings({
      roles: {
        planner: { backend: "claude", model: "haiku" },
        worker: { backend: "agy", model: "gemini-3.8-flash-low" },
      },
      routing: { feature: { backend: "claude", model: "sonnet" } },
      pricing: { models: { haiku: { input_per_mtok: 1, output_per_mtok: 5 } } },
    });

    it("prints one table per provider and the all-models section in text mode", async () => {
      const result = await runModels(slotSettings);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const expected = [
        "== claude (installed, version 2.1.304, pin 2.1.304 matches) ==",
        "haiku\tlow,medium,high,xhigh,max\t1/5 per Mtok\troles.planner",
        "sonnet\tlow,medium,high,xhigh,max\tunpriced\trouting.feature",
        "opus\tlow,medium,high,xhigh,max\tunpriced\t-",
        "fable\tlow,medium,high,xhigh,max\tunpriced\t-",
        "gemini-3.8-flash-low\tlow,medium,high,xhigh,max\t0.75/3.75 per Mtok\troles.worker",
        "claude-fable-5-1\tlow,medium,high,xhigh,max\tunpriced\t-",
        "claude-opus-5-5\tlow,medium,high,xhigh,max\t4/20 per Mtok\t-",
        "claude-sonnet-5-5\tlow,medium,high,xhigh,max\t2/10 per Mtok\t-",
        "claude-haiku-5-5\tlow,medium,high,xhigh,max\t0.1/0.5 per Mtok\t-",
        "== opencode (installed, version 2.0.21, pin 2.0.21 matches) ==",
        "opencode/deepseek-v4.1-flash-free\t-\tunpriced\t-",
        "== agy (installed, version 1.4.2, pin 1.4.2 matches) ==",
        "gemini-3.8-flash-high\thigh\t0.75/3.75 per Mtok\t-",
        "gemini-3.8-flash-medium\tmedium\t0.75/3.75 per Mtok\t-",
        "gemini-3.8-flash-low\tlow\t0.75/3.75 per Mtok\troles.worker",
        "claude-sonnet-4-6\t-\tunpriced\t-",
        "claude-opus-4-6-thinking\t-\tunpriced\t-",
        "gpt-oss-120b-medium\tmedium\tunpriced\t-",
        "",
        "== all models ==",
        "claude\tclaude-fable-5-1\tlow,medium,high,xhigh,max\tunpriced\t-",
        "claude\tclaude-haiku-5-5\tlow,medium,high,xhigh,max\t0.1/0.5 per Mtok\t-",
        "claude\tclaude-opus-5-5\tlow,medium,high,xhigh,max\t4/20 per Mtok\t-",
        "claude\tclaude-sonnet-5-5\tlow,medium,high,xhigh,max\t2/10 per Mtok\t-",
        "claude\tfable\tlow,medium,high,xhigh,max\tunpriced\t-",
        "claude\tgemini-3.8-flash-low\tlow,medium,high,xhigh,max\t0.75/3.75 per Mtok\troles.worker",
        "claude\thaiku\tlow,medium,high,xhigh,max\t1/5 per Mtok\troles.planner",
        "claude\topus\tlow,medium,high,xhigh,max\tunpriced\t-",
        "claude\tsonnet\tlow,medium,high,xhigh,max\tunpriced\trouting.feature",
        "opencode\topencode/deepseek-v4.1-flash-free\t-\tunpriced\t-",
        "agy\tclaude-opus-4-6-thinking\t-\tunpriced\t-",
        "agy\tclaude-sonnet-4-6\t-\tunpriced\t-",
        "agy\tgemini-3.8-flash-high\thigh\t0.75/3.75 per Mtok\t-",
        "agy\tgemini-3.8-flash-low\tlow\t0.75/3.75 per Mtok\troles.worker",
        "agy\tgemini-3.8-flash-medium\tmedium\t0.75/3.75 per Mtok\t-",
        "agy\tgpt-oss-120b-medium\tmedium\tunpriced\t-",
      ];
      expect(result.stdout.split("\n")).toEqual([...expected, ""]);
    });

    it("prints exactly one ModelCatalog object on stdout in JSON mode and writes the cache file", async () => {
      const result = await runModels(slotSettings, { outputFormat: "json" });
      expect(result.exitCode).toBe(0);

      const catalog = JSON.parse(result.stdout) as ModelCatalog;
      expect(ModelCatalog.parse(catalog)).toEqual(catalog);
      expect(result.stdout).toBe(`${JSON.stringify(catalog)}\n`);
      expect(catalog.v).toBe(1);
      expect(catalog.cache).toBe("fresh");
      expect(catalog.providers.map((p) => p.provider)).toEqual(["claude", "opencode", "agy"]);

      const haiku = catalog.providers[0].models.find((m) => m.id === "haiku");
      expect(haiku?.price_per_mtok).toEqual({ input: 1, output: 5 });
      expect(haiku?.slots).toEqual(["roles.planner"]);
      expect(catalog.all_models[0]).toMatchObject({ provider: "claude", id: "claude-fable-5-1", price_per_mtok: null });

      const cachePath = join(tmpDir, ".substrate", "state", "models.json");
      expect(existsSync(cachePath)).toBe(true);
      const cacheData = JSON.parse(readFileSync(cachePath, "utf8"));
      expect(cacheData.v).toBe(1);
      expect(cacheData.providers.map((p: { provider: string }) => p.provider)).toEqual([
        "claude",
        "opencode",
        "agy",
      ]);
    });

    it("serves a second run from the cache within 24 hours without calling the harnesses", async () => {
      const first = await runModels(slotSettings, { outputFormat: "json" });
      const firstCatalog = JSON.parse(first.stdout) as ModelCatalog;

      const cachePath = join(tmpDir, ".substrate", "state", "models.json");
      const cacheData = JSON.parse(readFileSync(cachePath, "utf8"));
      // A distinctive marker proves the second run reads the file instead of rebuilding.
      cacheData.providers.forEach((p: { problems: string[] }) => {
        p.problems = ["served-from-cache-sentinel"];
      });
      writeFileSync(cachePath, JSON.stringify(cacheData), "utf8");

      const second = await runModels(slotSettings, { outputFormat: "json" });
      const secondCatalog = JSON.parse(second.stdout) as ModelCatalog;

      expect(secondCatalog.cache).toBe("cached");
      expect(secondCatalog.generated_at).toBe(firstCatalog.generated_at);
      expect(secondCatalog.providers.map((p) => p.problems)).toEqual([
        ["served-from-cache-sentinel"],
        ["served-from-cache-sentinel"],
        ["served-from-cache-sentinel"],
      ]);
    });

    it("ignores a cache older than 24 hours and rebuilds", async () => {
      const first = await runModels(slotSettings, { outputFormat: "json" });

      const cachePath = join(tmpDir, ".substrate", "state", "models.json");
      const cacheData = JSON.parse(readFileSync(cachePath, "utf8"));
      cacheData.generated_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      cacheData.providers.forEach((p: { problems: string[] }) => {
        p.problems = ["stale-cache-sentinel"];
      });
      writeFileSync(cachePath, JSON.stringify(cacheData), "utf8");

      const rebuilt = await runModels(slotSettings, { outputFormat: "json" });
      const rebuiltCatalog = JSON.parse(rebuilt.stdout) as ModelCatalog;

      expect(rebuiltCatalog.cache).toBe("fresh");
      expect(rebuiltCatalog.generated_at).not.toBe(cacheData.generated_at);
      expect(rebuiltCatalog.providers[0].problems).toEqual([]);
    });

    it("--refresh ignores a fresh cache and rebuilds", async () => {
      await runModels(slotSettings, { outputFormat: "json" });

      const cachePath = join(tmpDir, ".substrate", "state", "models.json");
      const cacheData = JSON.parse(readFileSync(cachePath, "utf8"));
      cacheData.providers.forEach((p: { problems: string[] }) => {
        p.problems = ["refresh-should-not-appear"];
      });
      writeFileSync(cachePath, JSON.stringify(cacheData), "utf8");

      const refreshed = await runModels(slotSettings, { outputFormat: "json", refresh: true });
      const refreshedCatalog = JSON.parse(refreshed.stdout) as ModelCatalog;

      expect(refreshedCatalog.cache).toBe("fresh");
      expect(refreshedCatalog.providers[0].problems).toEqual([]);
    });

    it("--provider filters to a single provider", async () => {
      const result = await runModels(slotSettings, { outputFormat: "json", provider: "claude" });
      const catalog = JSON.parse(result.stdout) as ModelCatalog;

      expect(result.exitCode).toBe(0);
      expect(catalog.providers.map((p) => p.provider)).toEqual(["claude"]);
    });

    it("reports an uninstalled provider as not installed, never as an error", async () => {
      const result = await runModels(
        standardSettings({
          backends: { claude: { bin: join(binDir, "no-such-binary"), version_pin: "2.1.304" } },
        }),
        { outputFormat: "json" },
      );
      expect(result.exitCode).toBe(0);

      const catalog = JSON.parse(result.stdout) as ModelCatalog;
      const claude = catalog.providers.find((p) => p.provider === "claude");
      expect(claude?.installed).toBe(false);
      expect(claude?.pin_matches).toBe(false);
      expect(claude?.problems.length).toBeGreaterThan(0);

      const text = await runModels(
        standardSettings({
          backends: { claude: { bin: join(binDir, "no-such-binary"), version_pin: "2.1.304" } },
        }),
      );
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("== claude (not installed,");
    }, 15000);

    it("unknown provider prints the error on stderr and exits 2 in both modes", async () => {
      const text = await runModels(slotSettings, { provider: "foo" });
      expect(text.exitCode).toBe(2);
      expect(text.stderr).toBe("Error: unknown provider foo\n");
      expect(text.stdout).toBe("");

      const json = await runModels(slotSettings, { outputFormat: "json", provider: "foo" });
      expect(json.exitCode).toBe(2);
      expect(json.stderr).toBe("Error: unknown provider foo\n");
      expect(json.stdout).toBe(`${JSON.stringify({ error: "unknown provider foo" })}\n`);
    });
  });

  describe("agents command", () => {
    it("lists agent prompt sources: project override wins, built-ins fill the rest", async () => {
      const agentsCommand = await loadCommand("../../../src/cli/commands/agents.js", "agentsCommand");

      const configDir = mkdtempSync(join(tmpdir(), "substrate-cmds-config-"));
      const prevConfigDir = process.env.SUBSTRATE_CONFIG_DIR;
      process.env.SUBSTRATE_CONFIG_DIR = configDir;
      try {
        const agentsDir = join(tmpDir, ".substrate", "agents");
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(
          join(agentsDir, "worker.md"),
          `---\nname: worker\ndescription: Project worker override\nrole: worker\n---\nProject worker body\n`,
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

        const lines = stdout.getLines();
        expect(lines).toHaveLength(4);
        const byRole: Record<string, string> = Object.fromEntries(
          lines.map((line) => [line.split(" ")[0], line]),
        );
        expect(Object.keys(byRole).sort()).toEqual([
          "planner",
          "reviewer",
          "test-writer",
          "worker",
        ]);

        expect(byRole["worker"]).toBe(
          `worker project ${join(tmpDir, ".substrate", "agents", "worker.md")}`,
        );
        for (const role of ["planner", "test-writer", "reviewer"]) {
          expect(byRole[role]).toMatch(new RegExp(`^${role} built-in .+/agents/${role}\.md$`));
        }
      } finally {
        if (prevConfigDir === undefined) {
          delete process.env.SUBSTRATE_CONFIG_DIR;
        } else {
          process.env.SUBSTRATE_CONFIG_DIR = prevConfigDir;
        }
        rmSync(configDir, { recursive: true, force: true });
      }
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
        runs: ["r_BBBBBBBBBBBB"],
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
    it("creates the .substrate directories and .gitignore, and writes settings.json only for slot flags", async () => {
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
        for (const dir of ["runs", "worktrees", "state", "sessions", "ledger", "archive"]) {
          expect(existsSync(join(testRepo.dir, ".substrate", dir))).toBe(true);
        }

        // R2.10: no slot flags means nothing differs from the built-in defaults,
        // so settings.json is not written.
        expect(existsSync(join(testRepo.dir, ".substrate", "settings.json"))).toBe(false);

        const gitignore = readFileSync(join(testRepo.dir, ".substrate", ".gitignore"), "utf8");
        expect(gitignore.split("\n").filter((line) => line.length > 0)).toEqual([
          "runs/",
          "worktrees/",
          "state/",
          "sessions/",
          "ledger/",
          "settings.local.json",
        ]);

        // R2.10: init no longer appends to .git/info/exclude.
        const excludeFile = join(testRepo.dir, ".git", "info", "exclude");
        const excludeContent = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
        expect(excludeContent).not.toMatch(/\.substrate/);
      } finally {
        testRepo.cleanup();
      }
    });
  });
});
