import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R8.1: a run that loses a task still reports what happened. Independent tasks keep going,
// dependents of a failed task are skipped and say why, a partial run lands nothing with the
// merge flag, and the run ends failed (exit 1) with its reason, not paused.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

function eventsOf(res: RunSubstrateResult, type: string): Array<{ type: string; data: any }> {
  return res.events.filter((e) => e.type === type).map((e) => ({ type: e.type, data: e.data as any }));
}

function diagnostics(res: RunSubstrateResult): string {
  return `stdout: ${res.stdout.slice(-1500)}\nstderr: ${res.stderr.slice(-800)}`;
}

describe("R8.1 graceful: failures are reported, contained and cleaned up", () => {
  it("a worker that crashes fails its task as worker_crashed, and the sibling task still passes", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    // The first attempt of T1 crashes, then the two replan sessions the ladder runs for it
    // crash too; the next call is T2's worker.
    const crash = Array.from({ length: 3 }, () => ({ failure: "crash" }));
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Crash", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          ...crash,
          { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" },
          ...Array.from({ length: 12 }, () => ({ reply: "DONE" })),
        ],
      },
      args: [...RUN_ARGS, "Crash case"],
    });
    try {
      const failed = eventsOf(res, "task.failed").find((e) => e.data.task_id === "T1");
      expect(failed?.data.failure_class).toBe("worker_crashed");
      expect(eventsOf(res, "task.merged").map((e) => e.data.task_id)).toContain("T2");
      expect(res.exitCode, diagnostics(res)).toBe(1);
      expect(res.stdout).not.toContain("paused");
    } finally {
      res.cleanup();
    }
  });

  it("a partial run: the failed task and its dependent are reported, the independent task stays on the run branch, and nothing lands with the merge flag", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q never-there src/b.txt" });
    const t3 = taskSpec({ id: "T3", write: ["src/c.txt"], dependsOn: ["T2"], verify: "grep -q t3-done src/c.txt" });
    const ladder = Array.from({ length: 12 }, () => ({ reply: "DONE" }));
    let headBefore = "";
    const res = runSubstrate({
      files: SEED,
      beforeRun: (repo) => {
        headBefore = git(repo.dir, ["rev-parse", "HEAD"]);
      },
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Partial", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" },
          { edits: { "src/b.txt": "seed b\nbroken\n" }, reply: "DONE" },
          { edits: { "src/b.txt": "seed b\nbroken again\n" }, reply: "DONE" },
          ...ladder,
        ],
      },
      args: [...RUN_ARGS, "--merge", "Partial case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);

      const skipped = eventsOf(res, "task.skipped").find((e) => e.data.task_id === "T3");
      expect(skipped?.data.reason).toBe("dependency_failed");
      expect(skipped?.data.failed).toEqual(["T2"]);
      expect(res.stdout).toContain("[task T3] skipped (depends on T2, which failed)");
      expect(eventsOf(res, "task.merged").map((e) => e.data.task_id)).toEqual(["T1"]);

      // Nothing lands in the user's branch from a partial run; the passed work stays on the run branch.
      expect(git(res.repoDir, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(res.stdout).toContain("Tasks:      1 passed, 1 failed, 1 skipped / 3 total");
      expect(res.stdout).toMatch(/Nothing was merged\. 1 of 3 tasks finished; T2 failed/);
      const runBranch = git(res.repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/substrate/runs/"]);
      expect(runBranch.length).toBeGreaterThan(0);

      // The failed task's work is kept as evidence under the run directory, and its workspace is gone.
      const packets = join(res.runDir as string, "packets");
      expect(existsSync(join(packets, "T2-g1.patch"))).toBe(true);
      expect(readFileSync(join(packets, "T2-g1.patch"), "utf8")).toContain("broken");
      expect(git(res.repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
      expect(git(res.repoDir, ["branch", "--format=%(refname:short)"]).split("\n").filter((b) => b.startsWith("substrate/tasks/"))).toEqual([]);
      const wt = join(res.repoDir, ".substrate", "worktrees");
      expect(!existsSync(wt) || readdirSync(wt).length === 0).toBe(true);
    } finally {
      res.cleanup();
    }
  });
});
