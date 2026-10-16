import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import * as MergerModule from "../../../src/git/merger.js";
import type { TaskMerger, PreflightResult } from "../../../src/git/merger.js";

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

describe("merge: TaskMerger - preflight conflict detection", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-preflight-test-");
    repo.commitFile("base.txt", "line 1\nline 2\nline 3\n");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("detects clean merge without modifying working tree or index", async () => {
    const merger = getTaskMerger();

    // Create target run branch from main
    repo.createBranch("substrate/run-1", "main");
    // Diverge target branch by modifying fileA
    repo.git(["checkout", "substrate/run-1"]);
    repo.commitFile("fileA.txt", "feature A\n");

    // Create task branch from main (before target commit)
    repo.createBranch("substrate/run-1/taskA-g1", "main");
    repo.git(["checkout", "substrate/run-1/taskA-g1"]);
    repo.commitFile("fileB.txt", "feature B\n");

    // Checkout main again to verify working tree remains clean
    repo.git(["checkout", "main"]);

    const preflight: PreflightResult = await merger.preflight(
      repo.dir,
      "substrate/run-1",
      "substrate/run-1/taskA-g1",
    );

    expect(preflight.clean).toBe(true);
    expect(preflight.conflictFiles).toEqual([]);
    expect(preflight.treeSha).toBeDefined();
    expect(typeof preflight.treeSha).toBe("string");

    // Invariant: working tree is pure and untouched
    const status = repo.git(["status", "--porcelain"]);
    expect(status).toBe("");
  });

  it("detects merge conflict in-memory without generating conflict markers or touching index", async () => {
    const merger = getTaskMerger();

    // Target branch modifies base.txt
    repo.createBranch("substrate/run-2", "main");
    repo.git(["checkout", "substrate/run-2"]);
    writeFileSync(join(repo.dir, "base.txt"), "target branch version\n", "utf8");
    repo.git(["add", "base.txt"]);
    repo.git(["commit", "-m", "target modifies base.txt"]);

    // Task branch also modifies base.txt conflictingly
    repo.createBranch("substrate/run-2/taskConflict-g1", "main");
    repo.git(["checkout", "substrate/run-2/taskConflict-g1"]);
    writeFileSync(join(repo.dir, "base.txt"), "task branch version\n", "utf8");
    repo.git(["add", "base.txt"]);
    repo.git(["commit", "-m", "task modifies base.txt"]);

    repo.git(["checkout", "main"]);

    const preflight: PreflightResult = await merger.preflight(
      repo.dir,
      "substrate/run-2",
      "substrate/run-2/taskConflict-g1",
    );

    expect(preflight.clean).toBe(false);
    expect(preflight.conflictFiles).toContain("base.txt");

    // Invariant: no conflict markers on disk or dirty status
    const status = repo.git(["status", "--porcelain"]);
    expect(status).toBe("");
  });
});
