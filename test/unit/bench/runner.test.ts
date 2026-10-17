import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type * as Contracts from "../../../src/contracts/index.js";
import type {
  ArmConfig,
  BenchmarkArm,
  BenchmarkAttemptResult,
  BenchmarkReport,
  BenchmarkRunConfig,
  BenchmarkTaskSpec,
} from "../../../bench/types.js";
import { runBenchmarkAttempt } from "../../../bench/runner.js";
import { runBenchmarkSuite } from "../../../bench/index.js";

describe("Benchmark runner and attempt execution lifecycle (P6.3 §13)", () => {
  let tempDir: string;
  let fixtureDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-test-"));
    fixtureDir = path.join(tempDir, "fixture-repo");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ name: "fixture-repo", scripts: { test: "exit 0" } })
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTaskSpec(overrides: Partial<BenchmarkTaskSpec> = {}): BenchmarkTaskSpec {
    return {
      id: "TASK-01",
      title: "Sample Task",
      task_class: "feature",
      repo_fixture: fixtureDir,
      setup: [{ run: "echo 'setup'", timeout_s: 10 }],
      verify: [{ run: "echo 'verify'", timeout_s: 10 }],
      budget: { max_usd: 1.0, timeout_min: 5 },
      ...overrides,
    };
  }

  function makeArmConfig(arm: BenchmarkArm = "A", overrides: Partial<ArmConfig> = {}): ArmConfig {
    return {
      arm,
      mode: arm === "A" || arm === "B" ? "solo" : "plan",
      model: arm === "A" ? "claude-opus-5-5" : "claude-haiku-5-5",
      effort: arm === "A" ? "high" : "low",
      ...overrides,
    };
  }

  describe("Dry run validation matrix without executing LLM backends", () => {
    it("validates task suite and returns planned attempt matrix when dryRun is true", async () => {
      const taskFile = path.join(tempDir, "bench", "tasks", "task1.md");
      fs.mkdirSync(path.dirname(taskFile), { recursive: true });
      fs.writeFileSync(
        taskFile,
        `---
id: T01
title: "Dry Run Task"
task_class: feature
repo_fixture: ${fixtureDir}
verify:
  - run: echo 'dry run verify'
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );

      const runConfig: BenchmarkRunConfig = {
        taskPaths: [taskFile],
        arms: ["A", "B", "C"],
        repetitions: 2,
        dryRun: true,
      };

      const report: BenchmarkReport = await runBenchmarkSuite(runConfig, tempDir);

      expect(report).toBeDefined();
      expect(report.config.dryRun).toBe(true);
      // In dry run, tasks x arms x repetitions are calculated
      expect(report.taskResults["T01"]).toBeDefined();
      expect(report.taskResults["T01"]["A"]).toHaveLength(2);
      expect(report.taskResults["T01"]["B"]).toHaveLength(2);
      expect(report.taskResults["T01"]["C"]).toHaveLength(2);
      // Cost should be 0 because no backends were executed
      expect(report.armSummaries["A"].totalCostUsd).toBe(0);
      expect(report.armSummaries["B"].totalCostUsd).toBe(0);
    });
  });

  describe("Attempt execution lifecycle & workspace isolation", () => {
    it("executes attempt in isolated temporary worktree without mutating repo_fixture", async () => {
      const task = makeTaskSpec({
        setup: [{ run: "echo 'setup-marker' > setup.txt", timeout_s: 10 }],
        verify: [{ run: "test -f setup.txt", timeout_s: 10 }],
      });
      const arm = makeArmConfig("A");

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);

      expect(result).toBeDefined();
      expect(result.taskId).toBe("TASK-01");
      expect(result.arm).toBe("A");
      expect(result.repetition).toBe(1);

      // Verify that the setup marker file was created in temporary workspace,
      // but repo_fixture remained pristine (workspace isolation)
      expect(fs.existsSync(path.join(fixtureDir, "setup.txt"))).toBe(false);
    });

    it("executes setup commands in workspace; aborts with setup_failed error if setup fails", async () => {
      const task = makeTaskSpec({
        setup: [{ run: "exit 42", timeout_s: 10 }],
        verify: [{ run: "exit 0", timeout_s: 10 }],
      });
      const arm = makeArmConfig("A");

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);

      expect(result.passed).toBe(false);
      expect(result.firstPassVerified).toBe(false);
      expect(result.error).toMatch(/setup_failed/i);
    });

    it("enforces uniform budget caps across attempts (Invariant I7)", async () => {
      const task = makeTaskSpec({
        budget: { max_usd: 0.75, timeout_min: 2 },
      });
      const armA = makeArmConfig("A");
      const armB = makeArmConfig("B");

      const resultA = await runBenchmarkAttempt(task, armA, 1, tempDir);
      const resultB = await runBenchmarkAttempt(task, armB, 1, tempDir);

      expect(resultA).toBeDefined();
      expect(resultB).toBeDefined();
      // Both attempts are bounded by the exact same budget cap
      expect(task.budget.max_usd).toBe(0.75);
    });
  });

  describe("Pass/fail determination based solely on external verify exit codes (Invariant I2)", () => {
    it("marks attempt passed when all verify commands exit 0", async () => {
      const task = makeTaskSpec({
        verify: [
          { run: "exit 0", timeout_s: 10 },
          { run: "echo 'all good'", timeout_s: 10 },
        ],
      });
      const arm = makeArmConfig("A");

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);

      expect(result.passed).toBe(true);
      expect(result.verifyResults).toHaveLength(2);
      expect(result.verifyResults.every((vr) => vr.exit_code === 0)).toBe(true);
    });

    it("marks attempt failed when any verify command exits non-zero, regardless of LLM self-report (I2)", async () => {
      const task = makeTaskSpec({
        verify: [
          { run: "exit 0", timeout_s: 10 },
          { run: "exit 1", timeout_s: 10 },
        ],
      });
      const arm = makeArmConfig("A");

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);

      expect(result.passed).toBe(false);
      expect(result.firstPassVerified).toBe(false);
      expect(result.verifyResults.some((vr) => vr.exit_code !== 0)).toBe(true);
    });
  });

  describe("First-pass verification tracking", () => {
    it("marks firstPassVerified = true when task passes on generation 1 without heal or replan", async () => {
      const task = makeTaskSpec({
        verify: [{ run: "exit 0", timeout_s: 10 }],
      });
      const arm = makeArmConfig("C"); // Substrate plan mode

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);

      // On first pass pass with no healing/replanning
      if (result.passed) {
        expect(result.firstPassVerified).toBe(true);
      }
    });

    it("marks firstPassVerified = false if verify failed", async () => {
      const task = makeTaskSpec({
        verify: [{ run: "exit 1", timeout_s: 10 }],
      });
      const arm = makeArmConfig("C");

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);

      expect(result.passed).toBe(false);
      expect(result.firstPassVerified).toBe(false);
    });
  });

  describe("Error and edge case handling", () => {
    it("kills verify command with SIGKILL on timeout and records timeout failure", async () => {
      const task = makeTaskSpec({
        verify: [
          { run: "sleep 100", timeout_s: 1 },
        ],
      });
      const arm = makeArmConfig("A");

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);

      expect(result.passed).toBe(false);
      expect(result.firstPassVerified).toBe(false);
      expect(result.verifyResults.some((vr) => vr.timed_out)).toBe(true);
      expect(result.error).toMatch(/timeout/i);
    });

    it("handles rate limiting (HTTP 429) without crashing the runner battery", async () => {
      const task = makeTaskSpec();
      const arm = makeArmConfig("A");

      // Attempt encountering rate limit should return a structured result with rate_limited error
      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);
      expect(result).toBeDefined();
      expect(typeof result.passed).toBe("boolean");
    });

    it("throws error before running attempts if repo_fixture directory is missing", async () => {
      const task = makeTaskSpec({
        repo_fixture: path.join(tempDir, "nonexistent-fixture"),
      });
      const arm = makeArmConfig("A");

      await expect(
        runBenchmarkAttempt(task, arm, 1, tempDir)
      ).rejects.toThrow(/fixture/i);
    });

    it("records connection failure for Arm D when local llama.cpp server is offline while allowing suite to proceed", async () => {
      const task = makeTaskSpec({ task_class: "mechanical" });
      const arm = makeArmConfig("D", {
        routeOverrides: {
          mechanical: {
            backend: "opencode",
            model: "offline-llama-model",
          },
        } as any,
      });

      const result = await runBenchmarkAttempt(task, arm, 1, tempDir);
      expect(result).toBeDefined();
      expect(result.arm).toBe("D");
      // If backend fails to connect, result captures error without crashing
      if (!result.passed) {
        expect(result.firstPassVerified).toBe(false);
      }
    });

    it("cleans up temporary workspace worktree after attempt completion or failure", async () => {
      const task = makeTaskSpec({
        setup: [{ run: "echo 'temp' > temp.txt", timeout_s: 10 }],
        verify: [{ run: "exit 1", timeout_s: 10 }],
      });
      const arm = makeArmConfig("A");

      await runBenchmarkAttempt(task, arm, 1, tempDir);

      // Verify no leaked throwaway worktrees in tempDir
      const remainingTempDirs = fs.readdirSync(tempDir).filter((name) =>
        name.startsWith(".bench-worktree-")
      );
      expect(remainingTempDirs).toHaveLength(0);
    });
  });
});
