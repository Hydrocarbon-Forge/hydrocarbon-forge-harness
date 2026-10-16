import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Contracts from "../../../src/contracts/index.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import * as MergerModule from "../../../src/git/merger.js";
import type {
  TaskMerger,
  BatchIntegrationMerger,
  BatchMergeResult,
} from "../../../src/git/merger.js";

function getTaskMerger(): TaskMerger {
  const mod = MergerModule as any;
  if (mod.TaskMerger) {
    if (typeof mod.TaskMerger === "function") {
      try {
        return new mod.TaskMerger();
      } catch {
        return mod.TaskMerger;
      }
    }
    return mod.TaskMerger;
  }
  if (mod.taskMerger) return mod.taskMerger;
  return mod as TaskMerger;
}

function getBatchIntegrationMerger(): BatchIntegrationMerger {
  const mod = MergerModule as any;
  if (mod.BatchIntegrationMerger) {
    if (typeof mod.BatchIntegrationMerger === "function") {
      try {
        return new mod.BatchIntegrationMerger();
      } catch {
        return mod.BatchIntegrationMerger;
      }
    }
    return mod.BatchIntegrationMerger;
  }
  if (mod.batchIntegrationMerger) return mod.batchIntegrationMerger;
  return mod as BatchIntegrationMerger;
}

describe("merge: TaskMerger - mergeTask and rollbackCheckpoint", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-merger-test-");
    repo.commitFile("src/main.ts", "console.log('main');\n");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("merges task branch into target branch with --no-ff and returns merge commit SHA", async () => {
    const merger = getTaskMerger();

    repo.createBranch("substrate/r1", "main");

    // Task branch diverged
    repo.createBranch("substrate/r1/TaskA-g1", "main");
    repo.git(["checkout", "substrate/r1/TaskA-g1"]);
    repo.commitFile("src/featureA.ts", "export const featureA = 1;\n", "feat: featureA");

    repo.git(["checkout", "main"]);

    const mergeSha = await merger.mergeTask(
      repo.dir,
      "substrate/r1",
      "substrate/r1/TaskA-g1",
      "merge: TaskA",
    );

    expect(mergeSha).toMatch(/^[a-f0-9]{40}$/);

    // Verify target branch HEAD is mergeSha
    const targetHead = repo.git(["rev-parse", "substrate/r1"]);
    expect(targetHead).toBe(mergeSha);

    // Verify featureA.ts exists in target branch
    const files = repo.git(["ls-tree", "-r", "--name-only", "substrate/r1"]);
    expect(files).toContain("src/featureA.ts");
  });

  it("rolls back run branch to specified checkpoint commit using rollbackCheckpoint", async () => {
    const merger = getTaskMerger();

    repo.createBranch("substrate/r1", "main");
    const initialCheckpoint = repo.git(["rev-parse", "substrate/r1"]);

    // Merge a commit into target
    repo.createBranch("substrate/r1/TaskTemp-g1", "main");
    repo.git(["checkout", "substrate/r1/TaskTemp-g1"]);
    repo.commitFile("temp.txt", "temp\n");
    repo.git(["checkout", "main"]);

    await merger.mergeTask(repo.dir, "substrate/r1", "substrate/r1/TaskTemp-g1", "merge temp");
    const postMergeSha = repo.git(["rev-parse", "substrate/r1"]);
    expect(postMergeSha).not.toBe(initialCheckpoint);

    // Rollback to initial checkpoint
    await merger.rollbackCheckpoint(repo.dir, "substrate/r1", initialCheckpoint);

    const rolledBackSha = repo.git(["rev-parse", "substrate/r1"]);
    expect(rolledBackSha).toBe(initialCheckpoint);
  });
});

describe("merge: BatchIntegrationMerger - runBatchMerge and deterministic bisection", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-batch-test-");
    repo.commitFile("package.json", '{"name":"app","scripts":{"test":"node test.js"}}\n');
    repo.commitFile("test.js", 'console.log("integration tests pass");\n');
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("merges batch cleanly, runs integration verify commands, and records checkpoint SHA", async () => {
    const batchMerger = getBatchIntegrationMerger();

    repo.createBranch("substrate/run-batch-1", "main");

    // Task A
    repo.createBranch("substrate/run-batch-1/TaskA-g1", "substrate/run-batch-1");
    repo.git(["checkout", "substrate/run-batch-1/TaskA-g1"]);
    repo.commitFile("src/a.js", "module.exports = 'a';\n");

    // Task B
    repo.createBranch("substrate/run-batch-1/TaskB-g1", "substrate/run-batch-1");
    repo.git(["checkout", "substrate/run-batch-1/TaskB-g1"]);
    repo.commitFile("src/b.js", "module.exports = 'b';\n");

    repo.git(["checkout", "main"]);

    const tasks = [
      { id: "TaskA", branch: "substrate/run-batch-1/TaskA-g1" },
      { id: "TaskB", branch: "substrate/run-batch-1/TaskB-g1" },
    ];

    const verify: Contracts.Command[] = [
      { run: "node test.js", timeout_s: 30 },
    ];

    const result: BatchMergeResult = await batchMerger.runBatchMerge(
      repo.dir,
      "substrate/run-batch-1",
      tasks,
      verify,
    );

    expect(result.ok).toBe(true);
    expect(result.mergedTasks).toEqual(["TaskA", "TaskB"]);
    expect(result.checkpointSha).toBeDefined();

    // Verify run branch HEAD matches checkpointSha
    const runHead = repo.git(["rev-parse", "substrate/run-batch-1"]);
    expect(runHead).toBe(result.checkpointSha);

    // Invariant: base branch main is never touched
    const mainHead = repo.git(["rev-parse", "main"]);
    expect(mainHead).not.toBe(runHead);
  });

  it("halts batch immediately when preflight detects a conflict in one of the tasks", async () => {
    const batchMerger = getBatchIntegrationMerger();

    repo.createBranch("substrate/run-batch-conf", "main");
    const initialCheckpoint = repo.git(["rev-parse", "substrate/run-batch-conf"]);

    // Task A modifies test.js cleanly
    repo.createBranch("substrate/run-batch-conf/TaskA-g1", "substrate/run-batch-conf");
    repo.git(["checkout", "substrate/run-batch-conf/TaskA-g1"]);
    repo.commitFile("src/clean.js", "console.log('clean');\n");

    // Task B modifies test.js conflictingly
    repo.createBranch("substrate/run-batch-conf/TaskB-g1", "substrate/run-batch-conf");
    repo.git(["checkout", "substrate/run-batch-conf/TaskB-g1"]);
    writeFileSync(join(repo.dir, "test.js"), "conflicting test content\n", "utf8");
    repo.git(["add", "test.js"]);
    repo.git(["commit", "-m", "task B edit test.js"]);

    // Run branch also changes test.js conflictingly
    repo.git(["checkout", "substrate/run-batch-conf"]);
    writeFileSync(join(repo.dir, "test.js"), "run branch conflicting content\n", "utf8");
    repo.git(["add", "test.js"]);
    repo.git(["commit", "-m", "run branch edit test.js"]);

    repo.git(["checkout", "main"]);

    const tasks = [
      { id: "TaskA", branch: "substrate/run-batch-conf/TaskA-g1" },
      { id: "TaskB", branch: "substrate/run-batch-conf/TaskB-g1" },
    ];

    const verify: Contracts.Command[] = [
      { run: "echo test", timeout_s: 30 },
    ];

    const result = await batchMerger.runBatchMerge(
      repo.dir,
      "substrate/run-batch-conf",
      tasks,
      verify,
    );

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("merge_conflict");
    expect(result.failedTask).toBe("TaskB");
  });

  it("bisects batch on integration failure to isolate culprit and resets run branch to clean state", async () => {
    const batchMerger = getBatchIntegrationMerger();

    repo.createBranch("substrate/run-bisect", "main");
    const initialCheckpoint = repo.git(["rev-parse", "substrate/run-bisect"]);

    // Task 1: Good task
    repo.createBranch("substrate/run-bisect/Task1-g1", "substrate/run-bisect");
    repo.git(["checkout", "substrate/run-bisect/Task1-g1"]);
    repo.commitFile("good1.txt", "good 1\n");

    // Task 2: Bad task - breaks integration test.js
    repo.createBranch("substrate/run-bisect/Task2-g1", "substrate/run-bisect");
    repo.git(["checkout", "substrate/run-bisect/Task2-g1"]);
    writeFileSync(join(repo.dir, "test.js"), "process.exit(1);\n", "utf8");
    repo.git(["add", "test.js"]);
    repo.git(["commit", "-m", "break test.js"]);

    // Task 3: Another task
    repo.createBranch("substrate/run-bisect/Task3-g1", "substrate/run-bisect");
    repo.git(["checkout", "substrate/run-bisect/Task3-g1"]);
    repo.commitFile("good3.txt", "good 3\n");

    repo.git(["checkout", "main"]);

    const tasks = [
      { id: "Task1", branch: "substrate/run-bisect/Task1-g1" },
      { id: "Task2", branch: "substrate/run-bisect/Task2-g1" },
      { id: "Task3", branch: "substrate/run-bisect/Task3-g1" },
    ];

    const verify: Contracts.Command[] = [
      { run: "node test.js", timeout_s: 30 },
    ];

    // Direct bisectBatch check
    const culprit = await batchMerger.bisectBatch(
      repo.dir,
      "substrate/run-bisect",
      initialCheckpoint,
      tasks,
      verify,
    );
    expect(culprit).toBe("Task2");

    // runBatchMerge integration verify failure check
    const result = await batchMerger.runBatchMerge(
      repo.dir,
      "substrate/run-bisect",
      tasks,
      verify,
    );

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("integration_failed");
    expect(result.culprit).toBe("Task2");

    // Invariant: run branch is never left in a broken/red state
    // Head should either be reset to state before culprit or pre-batch checkpoint
    const currentRunHead = repo.git(["rev-parse", "substrate/run-bisect"]);
    expect([initialCheckpoint, result.checkpointSha]).toContain(currentRunHead);
  });

  it("immediately isolates single-task batch failure without intermediate bisection steps", async () => {
    const batchMerger = getBatchIntegrationMerger();

    repo.createBranch("substrate/run-single-fail", "main");

    // Task that breaks test
    repo.createBranch("substrate/run-single-fail/SingleBad-g1", "substrate/run-single-fail");
    repo.git(["checkout", "substrate/run-single-fail/SingleBad-g1"]);
    writeFileSync(join(repo.dir, "test.js"), "process.exit(55);\n", "utf8");
    repo.git(["add", "test.js"]);
    repo.git(["commit", "-m", "break single test"]);

    repo.git(["checkout", "main"]);

    const tasks = [
      { id: "SingleBad", branch: "substrate/run-single-fail/SingleBad-g1" },
    ];

    const verify: Contracts.Command[] = [
      { run: "node test.js", timeout_s: 30 },
    ];

    const result = await batchMerger.runBatchMerge(
      repo.dir,
      "substrate/run-single-fail",
      tasks,
      verify,
    );

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe("integration_failed");
    expect(result.culprit).toBe("SingleBad");
  });
});
