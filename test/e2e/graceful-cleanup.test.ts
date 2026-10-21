import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R8.1: a finished run leaves the user's checkout as it found it. Worktrees and task
// branches of the run are removed; the run branch keeps the work; `.substrate/` never
// shows as untracked in the user's `git status`.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

// `git status --short` as the user sees it: `.substrate/` must not appear at all.
function userStatus(dir: string): string[] {
  return git(dir, ["status", "--short"]).split("\n").filter((line) => line.length > 0);
}

function worktreesOf(dir: string): string[] {
  return git(dir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function branchesOf(dir: string): string[] {
  return git(dir, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean);
}

function twoPassingTasks() {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  return {
    manifest: manifestFor("Two passing tasks", ["T1", "T2"]),
    specs: { "tasks/T1.md": t1, "tasks/T2.md": t2 },
    calls: [
      { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
      { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" },
    ],
  };
}

describe("R8.1 graceful: a finished run leaves no worktrees or task branches", () => {
  it("success without the merge flag: the checkout is untouched and no task workspace remains", () => {
    const plan = twoPassingTasks();
    let headBefore = "";
    const res = runSubstrate({
      files: SEED,
      beforeRun: (repo) => {
        headBefore = git(repo.dir, ["rev-parse", "HEAD"]);
      },
      scenario: { calls: [planCall(contractFiles(plan.manifest, plan.specs)), ...plan.calls] },
      args: [...RUN_ARGS, "Two passing tasks"],
    });
    try {
      expect(res.exitCode).toBe(0);
      expect(userStatus(res.repoDir)).toEqual([]);
      expect(git(res.repoDir, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(worktreesOf(res.repoDir)).toEqual([res.repoDir]);
      const runBranch = branchesOf(res.repoDir).filter((b) => b.startsWith("substrate/runs/"));
      expect(runBranch.length).toBe(1);
      expect(branchesOf(res.repoDir).filter((b) => b.startsWith("substrate/tasks/"))).toEqual([]);
      const wt = join(res.repoDir, ".substrate", "worktrees");
      expect(!existsSync(wt) || readdirSync(wt).length === 0).toBe(true);
    } finally {
      res.cleanup();
    }
  });

  it("success with the merge flag: the work lands on the user's branch and the workspaces are removed", () => {
    const plan = twoPassingTasks();
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(contractFiles(plan.manifest, plan.specs)), ...plan.calls] },
      args: [...RUN_ARGS, "--merge", "Two passing tasks"],
    });
    try {
      expect(res.exitCode).toBe(0);
      expect(userStatus(res.repoDir)).toEqual([]);
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toContain("t1-done");
      expect(git(res.repoDir, ["show", "HEAD:src/b.txt"])).toContain("t2-done");
      expect(worktreesOf(res.repoDir)).toEqual([res.repoDir]);
      expect(branchesOf(res.repoDir).filter((b) => b.startsWith("substrate/tasks/"))).toEqual([]);
    } finally {
      res.cleanup();
    }
  });
});
