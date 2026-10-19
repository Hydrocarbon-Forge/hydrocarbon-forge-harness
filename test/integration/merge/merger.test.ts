import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command, Settings, TaskId } from "../../../src/contracts/index.js";
import { VerifyRunner } from "../../../src/verify/runner.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import * as MergerModule from "../../../src/git/merger.js";

// The R3.6 interface (docs/plan/wp/R3.6.md): src/git/merger.ts exports the integration
// worktree primitives plus TaskMerger.preflight and the batch merger. The new functions
// are read through the module namespace so this file compiles against HEAD, where they
// do not exist yet, and fails at runtime because they are missing.
type CreateIntegrationWorktreeFn = (
  repoRoot: string,
  runId: string,
  baseSha: string
) => Promise<string>;

type MergeIntoFn = (
  worktreePath: string,
  taskBranch: string,
  msg: string
) => Promise<string>;

type AdvanceRunRefFn = (
  repoRoot: string,
  runId: string,
  newSha: string,
  expectedOldSha: string
) => Promise<void>;

type VerifyInFn = (
  worktreePath: string,
  commands: Command[],
  settings: Settings
) => Promise<boolean>;

interface TaskEntry {
  id: TaskId;
  branch: string;
}

interface BatchMergeResultR36 {
  ok: boolean;
  mergedTasks: TaskId[];
  failedTask?: TaskId;
  failureClass?: "merge_conflict" | "integration_failed";
  culprit?: TaskId;
  checkpointSha: string;
  conflictFiles?: string[];
  verifyRuns: number;
}

interface BatchIntegrationMergerR36 {
  runBatchMerge(
    repoRoot: string,
    runId: string,
    tasks: TaskEntry[],
    verify: Command[],
    settings: Settings
  ): Promise<BatchMergeResultR36>;
  bisectBatch(
    repoRoot: string,
    runId: string,
    checkpoint: string,
    tasks: TaskEntry[],
    verify: Command[],
    settings: Settings
  ): Promise<TaskId>;
}

interface TaskMergerR36 {
  preflight(
    repoRoot: string,
    target: string,
    taskBranch: string
  ): Promise<{ clean: boolean; conflictFiles: string[]; treeSha?: string }>;
}

// RunId shape is r_[A-Z2-7]{12}.
const RUN_ID = "r_MERGERTESTAA";
const RUN_REF = `refs/heads/substrate/runs/${RUN_ID}`;

function testSettings(): Settings {
  return { sandbox: { enabled: false, network: "allow" } } as unknown as Settings;
}

function getTaskMerger(): TaskMergerR36 {
  return MergerModule as unknown as TaskMergerR36;
}

function getBatchIntegrationMerger(): BatchIntegrationMergerR36 {
  return MergerModule as unknown as BatchIntegrationMergerR36;
}

describe("merge: integration worktree primitives (R3.6)", () => {
  let repo: TestRepo;
  let baseSha: string;

  beforeEach(() => {
    repo = createTestRepo("substrate-merger-r36-");
    baseSha = repo.commitFile("src/base.ts", "export const base = 1;\n");
    repo.createBranch(RUN_REF, baseSha);
  });

  afterEach(() => {
    repo.cleanup();
  });

  // The user's checkout: HEAD, branch and dirty state. Untracked files are excluded
  // here because the integration worktree itself sits inside the repository directory.
  function mainState(): { head: string; branch: string; status: string } {
    return {
      head: repo.git(["rev-parse", "HEAD"]),
      branch: repo.git(["rev-parse", "--abbrev-ref", "HEAD"]),
      status: repo.git(["status", "--porcelain", "--untracked-files=no"]),
    };
  }

  function worktreeLines(): string[] {
    return repo
      .git(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
  }

  function commitInWorktree(
    worktreePath: string,
    relPath: string,
    content: string,
    message: string
  ): string {
    writeFileSync(join(worktreePath, relPath), content, "utf8");
    repo.git(["-C", worktreePath, "add", relPath]);
    return repo.git(["-C", worktreePath, "commit", "-m", message]);
  }

  function taskBranchFor(taskId: string): string {
    return `substrate/tasks/${RUN_ID}/${taskId}-g1`;
  }

  function taskBranchWithCommit(taskId: string, relPath: string, content: string): string {
    const branch = taskBranchFor(taskId);
    repo.createBranch(branch, baseSha);
    repo.git(["checkout", branch]);
    const tip = repo.commitFile(relPath, content);
    repo.git(["checkout", "main"]);
    return tip;
  }

  function worktreePathForRun(): string {
    return join(repo.dir, ".substrate", "worktrees", RUN_ID, "integration");
  }

  it("createIntegrationWorktree returns .substrate/worktrees/<run_id>/integration detached at baseSha", async () => {
    const createIntegrationWorktree = MergerModule.createIntegrationWorktree as unknown as CreateIntegrationWorktreeFn;
    const worktreePath = await createIntegrationWorktree(repo.dir, RUN_ID, baseSha);

    expect(worktreePath).toBe(join(repo.dir, ".substrate", "worktrees", RUN_ID, "integration"));
    expect(existsSync(worktreePath)).toBe(true);
    expect(repo.git(["-C", worktreePath, "rev-parse", "HEAD"])).toBe(baseSha);
    expect(repo.git(["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD"); // detached
    expect(repo.git(["worktree", "list", "--porcelain"])).toContain(worktreePath);

    // The user's checkout keeps its branch and HEAD sha.
    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("reuses an integration worktree left by a previous crash and resets it to the run-branch sha", async () => {
    const createIntegrationWorktree = MergerModule.createIntegrationWorktree as unknown as CreateIntegrationWorktreeFn;
    const worktreePath = await createIntegrationWorktree(repo.dir, RUN_ID, baseSha);

    // A batch that crashed left a commit in the worktree.
    commitInWorktree(worktreePath, "stale.txt", "stale\n", "stale batch commit");
    const staleSha = repo.git(["-C", worktreePath, "rev-parse", "HEAD"]);
    expect(staleSha).not.toBe(baseSha);

    const reused = await createIntegrationWorktree(repo.dir, RUN_ID, baseSha);
    expect(reused).toBe(worktreePath);
    expect(repo.git(["-C", worktreePath, "rev-parse", "HEAD"])).toBe(baseSha);

    // One registered worktree besides the user's checkout, and the checkout is still on main.
    expect(worktreeLines()).toHaveLength(2);
    expect(repo.git(["worktree", "list", "--porcelain"])).toContain("branch refs/heads/main");
    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("mergeInto creates a two-parent merge commit in the worktree and returns the new HEAD", async () => {
    const createIntegrationWorktree = MergerModule.createIntegrationWorktree as unknown as CreateIntegrationWorktreeFn;
    const mergeInto = MergerModule.mergeInto as unknown as MergeIntoFn;
    const worktreePath = await createIntegrationWorktree(repo.dir, RUN_ID, baseSha);

    const branch = taskBranchFor("T1");
    const taskTip = taskBranchWithCommit("T1", "src/t1.ts", "export const t1 = 1;\n");

    const mergeSha = await mergeInto(worktreePath, branch, "merge: task T1");

    expect(repo.git(["-C", worktreePath, "rev-parse", "HEAD"])).toBe(mergeSha);
    const parents = repo
      .git(["-C", worktreePath, "rev-list", "--parents", "-n", "1", mergeSha])
      .split(/\s+/);
    expect(parents).toEqual([mergeSha, baseSha, taskTip]); // first parent: integration HEAD, second: task branch

    // The task branch tip is unchanged.
    expect(repo.git(["rev-parse", branch])).toBe(taskTip);

    // No branch is checked out in the user's checkout, and the run ref did not move.
    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
    expect(repo.git(["rev-parse", RUN_REF])).toBe(baseSha);
  });

  it("advanceRunRef moves the run ref when the expected old sha matches", async () => {
    const advanceRunRef = MergerModule.advanceRunRef as unknown as AdvanceRunRefFn;
    const taskTip = taskBranchWithCommit("T1", "src/t1.ts", "export const t1 = 1;\n");

    await advanceRunRef(repo.dir, RUN_ID, taskTip, baseSha);

    expect(repo.git(["rev-parse", RUN_REF])).toBe(taskTip);
    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("advanceRunRef rejects an expected-old mismatch and leaves the run ref unchanged", async () => {
    const advanceRunRef = MergerModule.advanceRunRef as unknown as AdvanceRunRefFn;
    const taskTip = taskBranchWithCommit("T1", "src/t1.ts", "export const t1 = 1;\n");

    await expect(
      advanceRunRef(repo.dir, RUN_ID, taskTip, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
    ).rejects.toThrow();

    expect(repo.git(["rev-parse", RUN_REF])).toBe(baseSha);
    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("verifyIn runs commands with cwd = the integration worktree and passes an empty list trivially", async () => {
    const createIntegrationWorktree = MergerModule.createIntegrationWorktree as unknown as CreateIntegrationWorktreeFn;
    const verifyIn = MergerModule.verifyIn as unknown as VerifyInFn;
    const worktreePath = await createIntegrationWorktree(repo.dir, RUN_ID, baseSha);

    // Empty commands pass without running anything. VerifyRunner itself does not pass an
    // empty result set, so the trivial pass must come from verifyIn before it calls the runner.
    expect(await verifyIn(worktreePath, [], testSettings())).toBe(true);
    expect(new VerifyRunner().isAllPassed([])).toBe(false);

    const writeCommand: Command[] = [
      {
        run: "node -e \"require('fs').writeFileSync('marker.txt', 'x')\"",
        timeout_s: 30,
      },
    ];
    expect(await verifyIn(worktreePath, writeCommand, testSettings())).toBe(true);
    expect(readFileSync(join(worktreePath, "marker.txt"), "utf8")).toBe("x");
    expect(existsSync(join(repo.dir, "marker.txt"))).toBe(false);

    const failingCommand: Command[] = [{ run: "node -e \"process.exit(1)\"", timeout_s: 30 }];
    expect(await verifyIn(worktreePath, failingCommand, testSettings())).toBe(false);
  });

  it("runBatchMerge merges in order, verifies once, advances the run ref and records the pre-batch sha", async () => {
    const batchMerger = getBatchIntegrationMerger();

    const tips = [
      taskBranchWithCommit("T1", "src/t1.ts", "export const t1 = 1;\n"),
      taskBranchWithCommit("T2", "src/t2.ts", "export const t2 = 2;\n"),
      taskBranchWithCommit("T3", "src/t3.ts", "export const t3 = 3;\n"),
    ];
    const tasks: TaskEntry[] = [
      { id: "T1", branch: taskBranchFor("T1") },
      { id: "T2", branch: taskBranchFor("T2") },
      { id: "T3", branch: taskBranchFor("T3") },
    ];

    const result = await batchMerger.runBatchMerge(
      repo.dir,
      RUN_ID,
      tasks,
      [{ run: "node -e \"process.exit(0)\"", timeout_s: 30 }],
      testSettings()
    );

    expect(result.ok).toBe(true);
    expect(result.mergedTasks).toEqual(["T1", "T2", "T3"]);
    expect(result.checkpointSha).toBe(baseSha);
    expect(result.verifyRuns).toBe(1);

    const worktreeHead = repo.git(["-C", worktreePathForRun(), "rev-parse", "HEAD"]);
    expect(repo.git(["rev-parse", RUN_REF])).toBe(worktreeHead);

    // The merge commits are chained in batch order: each one has the previous integration
    // HEAD as first parent and its own task branch tip as second parent.
    let sha = worktreeHead;
    for (let i = tasks.length - 1; i >= 0; i--) {
      const parents = repo
        .git(["-C", worktreePathForRun(), "rev-list", "--parents", "-n", "1", sha])
        .split(/\s+/);
      expect(parents.length).toBe(3);
      expect(parents[2]).toBe(tips[i]);
      sha = parents[1];
    }
    expect(sha).toBe(baseSha);

    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("runBatchMerge halts at a conflicting task with merge_conflict and does not advance the run ref", async () => {
    const batchMerger = getBatchIntegrationMerger();

    const tipT1 = taskBranchWithCommit("T1", "src/shared.ts", "content A\n");
    const tipT2 = taskBranchWithCommit("T2", "src/shared.ts", "content B\n");

    const result = await batchMerger.runBatchMerge(
      repo.dir,
      RUN_ID,
      [
        { id: "T1", branch: taskBranchFor("T1") },
        { id: "T2", branch: taskBranchFor("T2") },
      ],
      [{ run: "node -e \"process.exit(0)\"", timeout_s: 30 }],
      testSettings()
    );

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("merge_conflict");
    expect(result.failedTask).toBe("T2");
    expect(result.conflictFiles).toContain("src/shared.ts");
    expect(result.checkpointSha).toBe(baseSha);

    // The batch stopped at T2, and the run ref never moved.
    const worktreeHead = repo.git(["-C", worktreePathForRun(), "rev-parse", "HEAD"]);
    expect(repo.git(["rev-parse", RUN_REF])).toBe(baseSha);
    const parents = repo
      .git(["-C", worktreePathForRun(), "rev-list", "--parents", "-n", "1", worktreeHead])
      .split(/\s+/);
    expect(parents).toEqual([worktreeHead, baseSha, tipT1]);

    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("bisectBatch names the culprit in batch order and runBatchMerge stays within 1 + N verify runs", async () => {
    const batchMerger = getBatchIntegrationMerger();

    const tipT1 = taskBranchWithCommit("T1", "src/t1.ts", "export const t1 = 1;\n");
    const tipT2 = taskBranchWithCommit("T2", "src/bad.ts", "BAD\n");
    taskBranchWithCommit("T3", "src/t3.ts", "export const t3 = 3;\n");

    const tasks: TaskEntry[] = [
      { id: "T1", branch: taskBranchFor("T1") },
      { id: "T2", branch: taskBranchFor("T2") },
      { id: "T3", branch: taskBranchFor("T3") },
    ];

    // Integration verify fails while the culprit's file is present in the worktree.
    const failingVerify: Command[] = [
      {
        run: "node -e \"process.exit(require('fs').existsSync('src/bad.ts') ? 1 : 0)\"",
        timeout_s: 30,
      },
    ];

    const result = await batchMerger.runBatchMerge(
      repo.dir,
      RUN_ID,
      tasks,
      failingVerify,
      testSettings()
    );

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("integration_failed");
    expect(result.culprit).toBe("T2");
    expect(result.mergedTasks).toEqual([]);
    expect(result.checkpointSha).toBe(baseSha);

    // One batch verify plus one per task until the first failure: T1 passed, T2 failed,
    // so the scan stopped there. Bound is 1 + 3, and the scan order is the batch order.
    expect(result.verifyRuns).toBe(3);
    expect(result.verifyRuns).toBeLessThanOrEqual(1 + tasks.length);

    // The run ref never moved on a failing batch, and the worktree is reset to the last
    // good sha, which is T1's merge commit: T3 was never merged.
    expect(repo.git(["rev-parse", RUN_REF])).toBe(baseSha);
    const worktreeHead = repo.git(["-C", worktreePathForRun(), "rev-parse", "HEAD"]);
    const parents = repo
      .git(["-C", worktreePathForRun(), "rev-list", "--parents", "-n", "1", worktreeHead])
      .split(/\s+/);
    expect(parents).toEqual([worktreeHead, baseSha, tipT1]);

    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("a single-task batch that fails verify names that task as culprit and leaves nothing merged", async () => {
    const batchMerger = getBatchIntegrationMerger();

    taskBranchWithCommit("T1", "src/bad.ts", "BAD\n");

    const failingVerify: Command[] = [
      {
        run: "node -e \"process.exit(require('fs').existsSync('src/bad.ts') ? 1 : 0)\"",
        timeout_s: 30,
      },
    ];

    const result = await batchMerger.runBatchMerge(
      repo.dir,
      RUN_ID,
      [{ id: "T1", branch: taskBranchFor("T1") }],
      failingVerify,
      testSettings()
    );

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("integration_failed");
    expect(result.culprit).toBe("T1");
    expect(result.mergedTasks).toEqual([]); // the batch is empty after the failure
    expect(result.verifyRuns).toBeLessThanOrEqual(1 + 1);

    // Nothing merged: the worktree is back at the pre-batch sha.
    expect(repo.git(["-C", worktreePathForRun(), "rev-parse", "HEAD"])).toBe(baseSha);
    expect(repo.git(["rev-parse", RUN_REF])).toBe(baseSha);

    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });
  });

  it("TaskMerger keeps preflight only: mergeTask and rollbackCheckpoint are removed", async () => {
    const merger = getTaskMerger() as unknown as Record<string, unknown>;

    expect(typeof merger.preflight).toBe("function");
    expect(typeof merger.mergeTask).not.toBe("function");
    expect(typeof merger.rollbackCheckpoint).not.toBe("function");
  });

  it("the user's checkout keeps an untracked file byte-identical across batch merge, conflict and bisect", async () => {
    const batchMerger = getBatchIntegrationMerger();

    const untrackedContent = "untracked content that must survive\n";
    writeFileSync(join(repo.dir, "untracked.txt"), untrackedContent, "utf8");

    taskBranchWithCommit("T1", "src/t1.ts", "export const t1 = 1;\n");
    taskBranchWithCommit("T2", "src/bad.ts", "BAD\n");

    const failingVerify: Command[] = [
      {
        run: "node -e \"process.exit(require('fs').existsSync('src/bad.ts') ? 1 : 0)\"",
        timeout_s: 30,
      },
    ];

    const result = await batchMerger.runBatchMerge(
      repo.dir,
      RUN_ID,
      [
        { id: "T1", branch: taskBranchFor("T1") },
        { id: "T2", branch: taskBranchFor("T2") },
      ],
      failingVerify,
      testSettings()
    );

    expect(result.ok).toBe(false);
    expect(result.culprit).toBe("T2");

    expect(readFileSync(join(repo.dir, "untracked.txt"), "utf8")).toBe(untrackedContent);
    expect(mainState()).toEqual({ head: baseSha, branch: "main", status: "" });

    // Nothing from the batch reached the user's checkout.
    const mainTree = repo.git(["ls-tree", "-r", "--name-only", "main"]);
    expect(mainTree).not.toContain("src/bad.ts");
    expect(mainTree).not.toContain("src/t1.ts");
  });
});
