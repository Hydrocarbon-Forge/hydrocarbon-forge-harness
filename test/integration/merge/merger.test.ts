import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command, Settings } from "../../../src/contracts/index.js";
import { VerifyRunner } from "../../../src/verify/runner.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import * as MergerModule from "../../../src/git/merger.js";

// The R3.6 interface (docs/plan/wp/R3.6.md): src/git/merger.ts exports the integration
// worktree primitives plus TaskMerger.preflight. The primitives are read through the
// module namespace. The batch merge and bisect functions were removed in R5.3 (W2b); the
// live batch path is src/engine/actions/merge.ts, covered by the scenario and e2e tests.
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

  it("TaskMerger keeps preflight only: mergeTask and rollbackCheckpoint are removed", async () => {
    const merger = getTaskMerger() as unknown as Record<string, unknown>;

    expect(typeof merger.preflight).toBe("function");
    expect(typeof merger.mergeTask).not.toBe("function");
    expect(typeof merger.rollbackCheckpoint).not.toBe("function");
  });
});
