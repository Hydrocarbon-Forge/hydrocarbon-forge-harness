import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import { createTestRepo, type TestRepo } from "./test-repo.js";
import * as WorkspaceModule from "../../../src/git/workspace.js";
import type {
  WorkspaceManager,
  WorkspaceLifecycle,
  WorktreeInfo,
} from "../../../src/git/workspace.js";

function getWorkspaceManager(): WorkspaceManager {
  const mod = WorkspaceModule as any;
  if (mod.WorkspaceManager) {
    if (typeof mod.WorkspaceManager === "function") {
      try {
        return new mod.WorkspaceManager();
      } catch {
        return mod.WorkspaceManager;
      }
    }
    return mod.WorkspaceManager;
  }
  if (mod.GitWorkspaceManager) {
    if (typeof mod.GitWorkspaceManager === "function") {
      try {
        return new mod.GitWorkspaceManager();
      } catch {
        return mod.GitWorkspaceManager;
      }
    }
    return mod.GitWorkspaceManager;
  }
  if (mod.workspaceManager) return mod.workspaceManager;
  return mod as WorkspaceManager;
}

function getWorkspaceLifecycle(): WorkspaceLifecycle {
  const mod = WorkspaceModule as any;
  if (mod.WorkspaceLifecycle) {
    if (typeof mod.WorkspaceLifecycle === "function") {
      try {
        return new mod.WorkspaceLifecycle();
      } catch {
        return mod.WorkspaceLifecycle;
      }
    }
    return mod.WorkspaceLifecycle;
  }
  if (mod.GitWorkspaceLifecycle) {
    if (typeof mod.GitWorkspaceLifecycle === "function") {
      try {
        return new mod.GitWorkspaceLifecycle();
      } catch {
        return mod.GitWorkspaceLifecycle;
      }
    }
    return mod.GitWorkspaceLifecycle;
  }
  if (mod.GitWorkspaceManager) {
    if (typeof mod.GitWorkspaceManager === "function") {
      try {
        return new mod.GitWorkspaceManager();
      } catch {
        return mod.GitWorkspaceManager;
      }
    }
    return mod.GitWorkspaceManager;
  }
  if (mod.workspaceLifecycle) return mod.workspaceLifecycle;
  return mod as WorkspaceLifecycle;
}

function getRunBranch(runId: Contracts.RunId): string {
  const mod = WorkspaceModule as any;
  if (typeof mod.getRunBranch === "function") return mod.getRunBranch(runId);
  if (mod.default?.getRunBranch) return mod.default.getRunBranch(runId);
  return mod.getRunBranch(runId);
}

function getTaskBranch(runId: Contracts.RunId, taskId: Contracts.TaskId, generation: number): string {
  const mod = WorkspaceModule as any;
  if (typeof mod.getTaskBranch === "function") return mod.getTaskBranch(runId, taskId, generation);
  if (mod.default?.getTaskBranch) return mod.default.getTaskBranch(runId, taskId, generation);
  return mod.getTaskBranch(runId, taskId, generation);
}

function makeSpec(id: string = "TaskA"): Contracts.TaskSpecFrontmatter {
  return Contracts.TaskSpecFrontmatter.parse({
    id,
    title: `Task ${id}`,
    class: "feature",
    depends_on: [],
    read: ["README.md"],
    write: ["src/**"],
    create: ["test/**"],
    protected: ["src/contracts/**"],
    verify: [{ run: "echo verify ok", timeout_s: 30 }],
  });
}

describe("git: branch naming helpers", () => {
  it("getRunBranch returns substrate/runs/<run_id>", () => {
    const runId = createRunId();
    expect(getRunBranch(runId)).toBe(`substrate/runs/${runId}`);
  });

  it("getTaskBranch returns substrate/tasks/<run_id>/<task_id>-g<generation>", () => {
    const runId = createRunId();
    expect(getTaskBranch(runId, "TaskA", 1)).toBe(`substrate/tasks/${runId}/TaskA-g1`);
    expect(getTaskBranch(runId, "TaskB", 2)).toBe(`substrate/tasks/${runId}/TaskB-g2`);
  });

  it("ensures run and task branches use non-conflicting Git ref hierarchies (no D/F conflict)", () => {
    const repo = createTestRepo("substrate-df-test-");
    try {
      const runId = createRunId();
      const runBranch = getRunBranch(runId);
      const taskBranch = getTaskBranch(runId, "TaskA", 1);

      // In Git, refs/heads/substrate/<run_id> and refs/heads/substrate/<run_id>/<task_id>-g1
      // would produce a D/F (directory/file) conflict.
      // With substrate/runs/<run_id> and substrate/tasks/<run_id>/<task_id>-g1, both refs can coexist cleanly.
      repo.createBranch(runBranch, "main");
      repo.createBranch(taskBranch, "main");

      const branches = repo.git(["branch", "--list"]);
      expect(branches).toContain(runBranch);
      expect(branches).toContain(taskBranch);
    } finally {
      repo.cleanup();
    }
  });
});

describe("git: WorkspaceManager - run and task branch management", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-ws-test-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("creates run branch substrate/runs/<run_id> from base_ref when it does not exist", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();

    const branchName = await manager.createRunBranch(repo.dir, runId, "main");
    expect(branchName).toBe(`substrate/runs/${runId}`);

    // Verify branch exists in git and points to main HEAD
    const branches = repo.git(["branch", "--list", branchName]);
    expect(branches).toContain(branchName);

    const mainSha = repo.git(["rev-parse", "main"]);
    const runSha = repo.git(["rev-parse", branchName]);
    expect(runSha).toBe(mainSha);
  });

  it("reuses existing run branch without error when already created", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();

    const branch1 = await manager.createRunBranch(repo.dir, runId, "main");
    const branch2 = await manager.createRunBranch(repo.dir, runId, "main");

    expect(branch1).toBe(`substrate/runs/${runId}`);
    expect(branch2).toBe(`substrate/runs/${runId}`);
  });

  it("preserves user base branch isolation without modifying main branch ref", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();
    const initialMainSha = repo.git(["rev-parse", "main"]);

    await manager.createRunBranch(repo.dir, runId, "main");

    const currentMainSha = repo.git(["rev-parse", "main"]);
    expect(currentMainSha).toBe(initialMainSha);
  });

  it("derives branch name substrate/tasks/<run_id>/<task_id>-g<generation> and creates worktree", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    const spec = makeSpec("TaskA");
    const info: WorktreeInfo = await manager.createTaskWorktree(repo.dir, runId, spec, 1, `substrate/runs/${runId}`);

    expect(info.branch).toBe(`substrate/tasks/${runId}/TaskA-g1`);
    expect(info.taskId).toBe("TaskA");
    expect(info.generation).toBe(1);
    expect(info.worktreePath).toBe(join(repo.dir, ".substrate", "worktrees", "TaskA-g1"));
    expect(existsSync(info.worktreePath)).toBe(true);

    // Verify branch was created in git
    const branchList = repo.git(["branch", "--list", info.branch]);
    expect(branchList).toContain(info.branch);
  });

  it("registers .substrate/worktrees/ and .substrate-task/ in .git/info/exclude", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    const spec = makeSpec("TaskA");
    await manager.createTaskWorktree(repo.dir, runId, spec, 1);

    const excludePath = join(repo.dir, ".git", "info", "exclude");
    expect(existsSync(excludePath)).toBe(true);

    const content = readFileSync(excludePath, "utf8");
    expect(content).toContain(".substrate/worktrees/");
    expect(content).toContain(".substrate-task/");
  });

  it("detects and cleans stale worktree directory before provisioning new worktree", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    const spec = makeSpec("TaskStale");
    const staleDir = join(repo.dir, ".substrate", "worktrees", "TaskStale-g1");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "stale_file.txt"), "leftover from crash", "utf8");

    // Creating worktree over stale directory must clean it up without throwing
    const info = await manager.createTaskWorktree(repo.dir, runId, spec, 1);
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(existsSync(join(info.worktreePath, "stale_file.txt"))).toBe(false);
  });

  it("ensures worktree isolation: untracked files in main repo are not present in worktree", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    // Create untracked file in main repo
    writeFileSync(join(repo.dir, "node_modules_dummy.txt"), "untracked package", "utf8");

    const spec = makeSpec("TaskIso");
    const info = await manager.createTaskWorktree(repo.dir, runId, spec, 1);

    expect(existsSync(join(info.worktreePath, "node_modules_dummy.txt"))).toBe(false);
  });
});

describe("git: WorkspaceManager - materializeSpec", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-spec-test-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("writes spec content to .substrate-task/TASK.md inside task worktree", async () => {
    const manager = getWorkspaceManager();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    const spec = makeSpec("TaskMat");
    const info = await manager.createTaskWorktree(repo.dir, runId, spec, 1);

    const specContent = "---\nid: TaskMat\ntitle: Materialize Test\n---\n## Objective\n";
    const materializedPath = await manager.materializeSpec(info.worktreePath, specContent);

    expect(materializedPath).toBe(join(info.worktreePath, ".substrate-task", "TASK.md"));
    expect(existsSync(materializedPath)).toBe(true);
    expect(readFileSync(materializedPath, "utf8")).toBe(specContent);
  });

  it("rejects when worktree directory does not exist", async () => {
    const manager = getWorkspaceManager();
    const nonExistentWorktree = join(repo.dir, ".substrate", "worktrees", "NonExistent-g1");

    await expect(
      manager.materializeSpec(nonExistentWorktree, "dummy content"),
    ).rejects.toThrow();
  });
});

describe("git: WorkspaceLifecycle - runSetup, removeWorktree, pruneWorktrees", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-life-test-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("executes setup commands in sequence with network enabled and returns VerifyResult[]", async () => {
    const manager = getWorkspaceManager();
    const lifecycle = getWorkspaceLifecycle();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    const spec = makeSpec("TaskSetup");
    const info = await manager.createTaskWorktree(repo.dir, runId, spec, 1);

    const commands: Contracts.Command[] = [
      { run: "touch setup_test_marker.txt", timeout_s: 30 },
      { run: "echo 'setup completed' > output.log", timeout_s: 30 },
    ];

    const results = await lifecycle.runSetup(info.worktreePath, commands);
    expect(results).toHaveLength(2);
    expect(results[0].exit_code).toBe(0);
    expect(results[1].exit_code).toBe(0);

    expect(existsSync(join(info.worktreePath, "setup_test_marker.txt"))).toBe(true);
    expect(readFileSync(join(info.worktreePath, "output.log"), "utf8")).toContain("setup completed");
  });

  it("halts workspace initialization and surfaces failure when a setup command fails", async () => {
    const manager = getWorkspaceManager();
    const lifecycle = getWorkspaceLifecycle();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    const spec = makeSpec("TaskSetupFail");
    const info = await manager.createTaskWorktree(repo.dir, runId, spec, 1);

    const commands: Contracts.Command[] = [
      { run: "exit 42", timeout_s: 30 },
      { run: "touch should_not_run.txt", timeout_s: 30 },
    ];

    await expect(lifecycle.runSetup(info.worktreePath, commands)).rejects.toThrow();
    expect(existsSync(join(info.worktreePath, "should_not_run.txt"))).toBe(false);
  });

  it("removes worktree with git worktree remove --force while preserving task branch", async () => {
    const manager = getWorkspaceManager();
    const lifecycle = getWorkspaceLifecycle();
    const runId = createRunId();
    await manager.createRunBranch(repo.dir, runId, "main");

    const spec = makeSpec("TaskRemove");
    const info = await manager.createTaskWorktree(repo.dir, runId, spec, 1);

    // Add uncommitted file inside worktree to verify --force removes it cleanly
    writeFileSync(join(info.worktreePath, "uncommitted.txt"), "temp file", "utf8");

    await lifecycle.removeWorktree(repo.dir, info.worktreePath);
    expect(existsSync(info.worktreePath)).toBe(false);

    // Preserves the task branch in git
    const branches = repo.git(["branch", "--list", info.branch]);
    expect(branches).toContain(info.branch);
  });

  it("prunes worktrees cleanly using pruneWorktrees", async () => {
    const lifecycle = getWorkspaceLifecycle();
    await expect(lifecycle.pruneWorktrees(repo.dir)).resolves.not.toThrow();
  });
});
