import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R8.2 graceful: concurrent tasks are isolated from each other and from the user's checkout,
// and a merge conflict leaves no conflict markers, MERGE_HEAD or unmerged paths behind.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

function unmergedPaths(dir: string): string[] {
  return git(dir, ["status", "--porcelain"]).split("\n").filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l));
}

function hasConflictMarkers(dir: string, ref: string): string[] {
  const out = spawnSync("git", ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>)", ref], { cwd: dir, encoding: "utf8" });
  return out.status === 0 ? out.stdout.split("\n").filter(Boolean) : [];
}

describe("R8.2 graceful: a merge conflict leaves no markers, MERGE_HEAD or unmerged paths", () => {
  it("the user's tree, the run branch and the user's branch are clean after a conflicted run", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/shared.txt"], verify: "grep -q t1-marker src/shared.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/shared.txt"], verify: "grep -q t2-marker src/shared.txt" });
    const res = runSubstrate({
      files: { "src/shared.txt": "initial shared content\n", "contracts/types.ts": CONTRACT_STUB },
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Conflict", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          { task: "T1", edits: { "src/shared.txt": "t1-marker\n" }, reply: "T1 done\nDONE" },
          { task: "T2", edits: { "src/shared.txt": "t2-marker\n" }, reply: "T2 done\nDONE" },
        ],
      },
      settings: { concurrency: { workers: 2 } },
      args: [...RUN_ARGS, "--merge", "Run the conflict case"],
    });
    try {
      expect(res.exitCode).toBe(1);
      expect(existsSync(join(res.repoDir, ".git", "MERGE_HEAD"))).toBe(false);
      expect(unmergedPaths(res.repoDir)).toEqual([]);
      expect(git(res.repoDir, ["status", "--porcelain"])).toBe("");
      expect(hasConflictMarkers(res.repoDir, "HEAD")).toEqual([]);
      const runBranch = git(res.repoDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/substrate/runs/"]).split("\n").filter(Boolean);
      expect(runBranch).toHaveLength(1);
      for (const b of runBranch) expect(hasConflictMarkers(res.repoDir, b)).toEqual([]);
      expect(git(res.repoDir, ["show", "HEAD:src/shared.txt"])).toBe("initial shared content");
    } finally {
      res.cleanup();
    }
  });
});

// Scenario 9. Two independent workers run side by side (R8.3, known issue 40), so the isolation is
// checked while they overlap: a sibling's worker starts from the run base, sees none of its
// sibling's files, and sees none of the user's uncommitted changes. The barrier shows they overlap.
describe("R8.2 graceful: scenario 9, a task cannot see its sibling's edits or the user's changes", () => {
  it("each worker sees only its own file and none of the user's uncommitted changes", () => {
    const barrier = mkdtempSync(join(tmpdir(), "substrate-probe-"));
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], create: ["probe/T1.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], create: ["probe/T2.txt"], verify: "grep -q t2-done src/b.txt" });
    const res = runSubstrate({
      files: SEED,
      beforeRun: (repo) => {
        // The user's checkout holds an uncommitted tracked change and an untracked file.
        writeFileSync(join(repo.dir, "README.md"), "# user's uncommitted edit\n", "utf8");
        writeFileSync(join(repo.dir, "user-notes.txt"), "not committed\n", "utf8");
      },
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Isolation", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          {
            task: "T1",
            edits: { "src/a.txt": "seed a\nt1-done\n" },
            probe: { dir: barrier, name: "T1" },
            trace: { dir: barrier, name: "T1", wait_for: ["T2"], timeout_ms: 5000 },
            reply: "T1 done\nDONE",
          },
          {
            task: "T2",
            edits: { "src/b.txt": "seed b\nt2-done\n" },
            probe: { dir: barrier, name: "T2" },
            trace: { dir: barrier, name: "T2", wait_for: ["T1"], timeout_ms: 5000 },
            reply: "T2 done\nDONE",
          },
        ],
      },
      settings: { concurrency: { workers: 2 } },
      args: [...RUN_ARGS, "Isolation case"],
    });
    try {
      expect(res.exitCode, `stdout: ${res.stdout.slice(-1200)}\nstderr: ${res.stderr.slice(-600)}`).toBe(0);
      const seen = ["T1", "T2"].map((name) => {
        const path = join(barrier, `seen-${name}.json`);
        expect(existsSync(path), `worker ${name} recorded its view`).toBe(true);
        return JSON.parse(readFileSync(path, "utf8")) as {
          name: string;
          top: string[];
          probe: string[];
          status: string[];
          readme: string;
        };
      });
      for (const view of seen) {
        // Only its own probe file is in probe/: the other worker's file is not visible.
        expect(view.probe).toEqual([`${view.name}.txt`]);
        expect(view.top).not.toContain("user-notes.txt");
        expect(view.readme).toBe("# E2E Test Repo\n");
        expect(view.status.join("\n")).not.toContain("user-notes.txt");
        expect(view.status.join("\n")).not.toContain("README.md");
        const other = view.name === "T1" ? "T2" : "T1";
        expect(view.status.join("\n")).not.toContain(`probe/${other}.txt`);
      }
      // The engine keeps both tasks' work on the run branch, and the user's checkout is unchanged.
      const status = spawnSync("git", ["status", "--short"], { cwd: res.repoDir, encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
      expect(status).toEqual([" M README.md", "?? user-notes.txt"]);
      const runRef = git(res.repoDir, ["for-each-ref", "--format=%(refname)", "refs/heads/substrate/runs/"]);
      expect(git(res.repoDir, ["show", `${runRef}:src/a.txt`])).toContain("t1-done");
      expect(git(res.repoDir, ["show", `${runRef}:src/b.txt`])).toContain("t2-done");
      expect(readdirSync(barrier).filter((f) => f.startsWith("seen-")).length).toBe(2);
      // R8.3: the two workers were alive at the same time (each barrier waits for the other's session).
      for (const name of ["T1", "T2"]) {
        expect(JSON.parse(readFileSync(join(barrier, `barrier-${name}.json`), "utf8")).met, `${name} overlapped its sibling`).toBe(true);
      }
    } finally {
      res.cleanup();
    }
  });
});
