import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskId, Command } from "../contracts/index.js";
import { VerifyRunner } from "../verify/runner.js";

export interface PreflightResult {
  clean: boolean;
  conflictFiles: string[];
  treeSha?: string;
}

export interface BatchMergeResult {
  ok: boolean;
  mergedTasks: TaskId[];
  failedTask?: TaskId;
  failureClass?: "merge_conflict" | "integration_failed";
  culprit?: TaskId;
  checkpointSha: string;
}

export interface TaskMerger {
  preflight(
    repoRoot: string,
    target: string,
    taskBranch: string
  ): Promise<PreflightResult>;
  mergeTask(
    repoRoot: string,
    target: string,
    taskBranch: string,
    msg: string
  ): Promise<string>;
  rollbackCheckpoint(
    repoRoot: string,
    runBranch: string,
    sha: string
  ): Promise<void>;
}

export interface BatchIntegrationMerger {
  runBatchMerge(
    repoRoot: string,
    runBranch: string,
    tasks: { id: TaskId; branch: string }[],
    verify: Command[]
  ): Promise<BatchMergeResult>;
  bisectBatch(
    repoRoot: string,
    runBranch: string,
    checkpoint: string,
    tasks: { id: TaskId; branch: string }[],
    verify: Command[]
  ): Promise<TaskId>;
}

async function runIntegrationVerify(
  repoRoot: string,
  runBranch: string,
  verify: Command[]
): Promise<boolean> {
  if (!verify || verify.length === 0) {
    return true;
  }
  const tempDir = mkdtempSync(join(tmpdir(), "substrate-integ-"));
  rmdirSync(tempDir);
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", tempDir, runBranch],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );
    const runner = new VerifyRunner();
    const results = await runner.runVerify({
      cwd: tempDir,
      commands: verify,
      sandbox: false,
      network: "allow",
    });
    return runner.isAllPassed(results);
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", tempDir], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch {
      // Ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export class TaskMergerImpl implements TaskMerger {
  async preflight(
    repoRoot: string,
    target: string,
    taskBranch: string
  ): Promise<PreflightResult> {
    try {
      const stdout = execFileSync(
        "git",
        ["merge-tree", "--write-tree", "--name-only", target, taskBranch],
        { cwd: repoRoot, encoding: "utf8" }
      );
      const treeSha = stdout.trim();
      return {
        clean: true,
        conflictFiles: [],
        treeSha,
      };
    } catch (err: any) {
      if (err.status === 1 && typeof err.stdout === "string") {
        const lines = err.stdout.split("\n");
        const treeSha = lines[0]?.trim() || undefined;
        const conflictFiles: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) break;
          conflictFiles.push(line);
        }
        return {
          clean: false,
          conflictFiles,
          treeSha,
        };
      }
      throw err;
    }
  }

  async mergeTask(
    repoRoot: string,
    target: string,
    taskBranch: string,
    msg: string
  ): Promise<string> {
    const curBranch = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();

    try {
      execFileSync("git", ["checkout", target], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      execFileSync(
        "git",
        ["merge", "--no-ff", "-m", msg, taskBranch],
        { cwd: repoRoot, encoding: "utf8" }
      );

      const mergeSha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: repoRoot, encoding: "utf8" }
      ).trim();

      return mergeSha;
    } finally {
      if (curBranch && curBranch !== "HEAD" && curBranch !== target) {
        try {
          execFileSync("git", ["checkout", curBranch], {
            cwd: repoRoot,
            encoding: "utf8",
          });
        } catch {
          // Ignore
        }
      }
    }
  }

  async rollbackCheckpoint(
    repoRoot: string,
    runBranch: string,
    sha: string
  ): Promise<void> {
    const curBranch = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();

    if (curBranch === runBranch) {
      execFileSync("git", ["reset", "--hard", sha], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    } else {
      const ref = runBranch.startsWith("refs/heads/")
        ? runBranch
        : `refs/heads/${runBranch}`;
      execFileSync("git", ["update-ref", ref, sha], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    }
  }
}

export class BatchIntegrationMergerImpl implements BatchIntegrationMerger {
  async runBatchMerge(
    repoRoot: string,
    runBranch: string,
    tasks: { id: TaskId; branch: string }[],
    verify: Command[]
  ): Promise<BatchMergeResult> {
    const merger = new TaskMergerImpl();
    const initialCheckpoint = execFileSync(
      "git",
      ["rev-parse", runBranch],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();

    const mergedTasks: TaskId[] = [];

    for (const task of tasks) {
      const pf = await merger.preflight(repoRoot, runBranch, task.branch);
      if (!pf.clean) {
        await merger.rollbackCheckpoint(repoRoot, runBranch, initialCheckpoint);
        return {
          ok: false,
          mergedTasks,
          failedTask: task.id,
          failureClass: "merge_conflict",
          checkpointSha: initialCheckpoint,
        };
      }

      await merger.mergeTask(
        repoRoot,
        runBranch,
        task.branch,
        `merge: ${task.id}`
      );
      mergedTasks.push(task.id);
    }

    const verified = await runIntegrationVerify(repoRoot, runBranch, verify);
    if (verified) {
      const checkpointSha = execFileSync(
        "git",
        ["rev-parse", runBranch],
        { cwd: repoRoot, encoding: "utf8" }
      ).trim();
      return {
        ok: true,
        mergedTasks,
        checkpointSha,
      };
    }

    if (tasks.length === 1) {
      const culprit = tasks[0].id;
      await merger.rollbackCheckpoint(repoRoot, runBranch, initialCheckpoint);
      return {
        ok: false,
        mergedTasks: [],
        failedTask: culprit,
        failureClass: "integration_failed",
        culprit,
        checkpointSha: initialCheckpoint,
      };
    }

    const culprit = await this.bisectBatch(
      repoRoot,
      runBranch,
      initialCheckpoint,
      tasks,
      verify
    );

    const currentRunHead = execFileSync(
      "git",
      ["rev-parse", runBranch],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();

    return {
      ok: false,
      mergedTasks: [],
      failedTask: culprit,
      failureClass: "integration_failed",
      culprit,
      checkpointSha: currentRunHead,
    };
  }

  async bisectBatch(
    repoRoot: string,
    runBranch: string,
    checkpoint: string,
    tasks: { id: TaskId; branch: string }[],
    verify: Command[]
  ): Promise<TaskId> {
    const merger = new TaskMergerImpl();
    await merger.rollbackCheckpoint(repoRoot, runBranch, checkpoint);

    for (const task of tasks) {
      const beforeTaskSha = execFileSync(
        "git",
        ["rev-parse", runBranch],
        { cwd: repoRoot, encoding: "utf8" }
      ).trim();

      await merger.mergeTask(
        repoRoot,
        runBranch,
        task.branch,
        `bisect: ${task.id}`
      );

      const passed = await runIntegrationVerify(repoRoot, runBranch, verify);
      if (!passed) {
        await merger.rollbackCheckpoint(repoRoot, runBranch, beforeTaskSha);
        return task.id;
      }
    }

    return tasks[tasks.length - 1].id;
  }
}

export const TaskMerger = TaskMergerImpl;
export const taskMerger = new TaskMergerImpl();

export const BatchIntegrationMerger = BatchIntegrationMergerImpl;
export const batchIntegrationMerger = new BatchIntegrationMergerImpl();
