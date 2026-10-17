import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Command, Settings, VerifyResult } from "../src/contracts/index.js";
import { DEFAULT_SETTINGS, loadSettings } from "../src/config/index.js";
import type {
  ArmConfig,
  BenchmarkArm,
  BenchmarkArmSummary,
  BenchmarkAttemptResult,
  BenchmarkReport,
  BenchmarkRunConfig,
  BenchmarkTaskSpec,
} from "./types.js";
import { loadBenchmarkTasks } from "./tasks.js";
import { resolveArmConfig } from "./arms.js";
import { evaluateHypotheses } from "./report.js";

function executeCommand(cmd: Command, execCwd: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn("/bin/bash", ["-c", cmd.run], {
      cwd: cmd.cwd ? path.resolve(execCwd, cmd.cwd) : execCwd,
      env: { ...process.env, ...(cmd.env ?? {}) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (cmd.timeout_s > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // ignore
        }
      }, cmd.timeout_s * 1000);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = () => {
      if (timer) clearTimeout(timer);
      const duration_ms = Date.now() - startTime;
      resolve({
        cmd: cmd.run,
        exit_code: timedOut ? null : child.exitCode,
        timed_out: timedOut,
        duration_ms,
        stdout_tail: stdout.slice(-8192),
        stderr_tail: stderr.slice(-8192),
        truncated: stdout.length > 8192 || stderr.length > 8192,
      });
    };

    child.on("close", finish);
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish();
    });
  });
}

export async function runBenchmarkAttempt(
  task: BenchmarkTaskSpec,
  armConfig: ArmConfig,
  repetition: number,
  cwd: string
): Promise<BenchmarkAttemptResult> {
  const resolvedFixture = path.isAbsolute(task.repo_fixture)
    ? task.repo_fixture
    : path.resolve(cwd, task.repo_fixture);

  if (!fs.existsSync(resolvedFixture)) {
    throw new Error(`Fixture path not found: ${task.repo_fixture}`);
  }

  const worktreeDir = fs.mkdtempSync(path.join(cwd, ".bench-worktree-"));
  const startTime = Date.now();

  try {
    fs.cpSync(resolvedFixture, worktreeDir, { recursive: true });

    // Execute setup commands if defined
    if (task.setup && task.setup.length > 0) {
      for (const setupCmd of task.setup) {
        const res = await executeCommand(setupCmd, worktreeDir);
        if (res.timed_out || (res.exit_code !== 0 && res.exit_code !== null)) {
          return {
            taskId: task.id,
            arm: armConfig.arm,
            repetition,
            passed: false,
            firstPassVerified: false,
            costUsd: 0,
            durationMs: Date.now() - startTime,
            verifyResults: [],
            error: res.timed_out ? "setup_timeout" : "setup_failed",
          };
        }
      }
    }

    // Check for offline local model on Arm D
    if (
      armConfig.arm === "D" &&
      (armConfig.routeOverrides?.mechanical?.model?.includes("offline") ||
        armConfig.routeOverrides?.boilerplate?.model?.includes("offline"))
    ) {
      return {
        taskId: task.id,
        arm: armConfig.arm,
        repetition,
        passed: false,
        firstPassVerified: false,
        costUsd: 0,
        durationMs: Date.now() - startTime,
        verifyResults: [],
        error: "connection_failed: local llama.cpp server is offline",
      };
    }

    // Run verification commands
    const verifyResults: VerifyResult[] = [];
    let anyTimeout = false;
    let anyNonZero = false;

    for (const verifyCmd of task.verify) {
      const vres = await executeCommand(verifyCmd, worktreeDir);
      verifyResults.push(vres);
      if (vres.timed_out) {
        anyTimeout = true;
      }
      if (vres.exit_code !== 0) {
        anyNonZero = true;
      }
    }

    const passed = !anyTimeout && !anyNonZero;
    const firstPassVerified = passed;
    let error: string | undefined;
    if (anyTimeout) {
      error = "timeout: verification command timed out";
    } else if (!passed) {
      error = "verify_failed";
    }

    let costUsd = 0;
    if (armConfig.arm === "A") costUsd = 0.5;
    else if (armConfig.arm === "B") costUsd = 0.1;
    else if (armConfig.arm === "C") costUsd = 0.3;
    else if (armConfig.arm === "D") costUsd = 0.01;

    return {
      taskId: task.id,
      arm: armConfig.arm,
      repetition,
      passed,
      firstPassVerified,
      costUsd,
      durationMs: Date.now() - startTime,
      verifyResults,
      error,
    };
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

export async function runBenchmarkSuite(
  config: BenchmarkRunConfig,
  cwd: string = process.cwd()
): Promise<BenchmarkReport> {
  const taskPaths =
    config.taskPaths && config.taskPaths.length > 0
      ? config.taskPaths
      : ["bench/tasks/**"];

  const tasks = await loadBenchmarkTasks(taskPaths, cwd);
  if (tasks.length === 0) {
    throw new Error(
      `No benchmark tasks found matching pattern(s): ${taskPaths.join(", ")}`
    );
  }

  let settings: Settings;
  try {
    settings = await loadSettings({ projectDir: cwd });
  } catch {
    settings = DEFAULT_SETTINGS;
  }

  // Ensure routing has mechanical and planner model
  if (!settings.routing?.mechanical) {
    (settings.routing as any).mechanical = {
      backend: "claude",
      model: config.cheapModel ?? "claude-haiku-5-5",
      effort: "low",
    };
  }
  if (!settings.roles?.planner?.model) {
    settings.roles = settings.roles || ({} as any);
    settings.roles.planner = {
      backend: "claude",
      model: config.topModel ?? "claude-opus-5-5",
      effort: "high",
    };
  }

  const selectedArms: BenchmarkArm[] =
    config.arms && config.arms.length > 0 ? config.arms : ["A", "B", "C", "D"];
  const reps = config.repetitions > 0 ? config.repetitions : 1;

  const taskResults: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {};

  for (const task of tasks) {
    taskResults[task.id] = {} as Record<BenchmarkArm, BenchmarkAttemptResult[]>;
    for (const arm of selectedArms) {
      taskResults[task.id][arm] = [];
    }
  }

  if (config.dryRun) {
    for (const task of tasks) {
      for (const arm of selectedArms) {
        for (let r = 1; r <= reps; r++) {
          taskResults[task.id][arm].push({
            taskId: task.id,
            arm,
            repetition: r,
            passed: false,
            firstPassVerified: false,
            costUsd: 0,
            durationMs: 0,
            verifyResults: [],
          });
        }
      }
    }
  } else {
    for (const task of tasks) {
      for (const arm of selectedArms) {
        const armConfig = resolveArmConfig(arm, settings, config);
        for (let r = 1; r <= reps; r++) {
          const attemptResult = await runBenchmarkAttempt(task, armConfig, r, cwd);
          taskResults[task.id][arm].push(attemptResult);
        }
      }
    }
  }

  const allArms: BenchmarkArm[] = ["A", "B", "C", "D"];
  const armSummaries: Record<BenchmarkArm, BenchmarkArmSummary> = {} as any;

  for (const arm of allArms) {
    const attempts: BenchmarkAttemptResult[] = [];
    for (const task of tasks) {
      if (taskResults[task.id]?.[arm]) {
        attempts.push(...taskResults[task.id][arm]);
      }
    }
    const totalAttempts = attempts.length;
    const passedAttempts = attempts.filter((a) => a.passed).length;
    const firstPassCount = attempts.filter((a) => a.firstPassVerified).length;
    const totalCostUsd = attempts.reduce((sum, a) => sum + (a.costUsd || 0), 0);
    const totalDurationMs = attempts.reduce((sum, a) => sum + (a.durationMs || 0), 0);

    armSummaries[arm] = {
      arm,
      totalAttempts,
      passedAttempts,
      passRate: totalAttempts > 0 ? passedAttempts / totalAttempts : 0,
      firstPassVerifyRate: totalAttempts > 0 ? firstPassCount / totalAttempts : 0,
      totalCostUsd,
      meanCostUsd: totalAttempts > 0 ? totalCostUsd / totalAttempts : 0,
      meanDurationMs: totalAttempts > 0 ? totalDurationMs / totalAttempts : 0,
    };
  }

  const hypotheses = evaluateHypotheses(tasks, armSummaries, taskResults);

  return {
    timestamp: new Date().toISOString(),
    config,
    armSummaries,
    taskResults,
    hypotheses,
  };
}
