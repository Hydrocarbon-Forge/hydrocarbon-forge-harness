import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runSubstrate } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R8.2 graceful: a landing the checkout refuses is a finished run that says why, and the same
// landing works once the checkout is clean. A failed task is reported as failed once.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "README.md": "# user's readme\n", "contracts/types.ts": CONTRACT_STUB };

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

describe("R8.2 graceful: a refused landing is a finished run", () => {
  it("--merge with uncommitted tracked changes: status finished, not merged, exit 1, and `substrate merge` lands the run once the tree is clean", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      beforeRun: (repo) => {
        writeFileSync(join(repo.dir, "README.md"), "# user is editing this\n", "utf8");
      },
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Dirty landing", ["T1"]), { "tasks/T1.md": t1 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
        ],
      },
      args: [...RUN_ARGS, "--merge", "Dirty landing"],
    });
    try {
      const runId = res.runDir?.split("/").at(-1) as string;
      expect(res.exitCode, res.stdout.slice(-1200)).toBe(1);
      expect(res.stdout).toContain("Status:     finished");
      expect(res.stdout).toContain("Merged:     no");
      expect(res.stdout).toContain(
        `not merged: your working tree has uncommitted changes; commit or stash them, then run: substrate merge ${runId}`,
      );
      expect(res.stdout).not.toContain("Reason:");
      expect(res.stdout).not.toContain("Drafts and logs");
      // The user's edit is untouched and the work is on the run branch.
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");

      // The user commits (here: restores the file), and the landing goes through.
      writeFileSync(join(res.repoDir, "README.md"), "# user's readme\n", "utf8");
      const landed = spawnSync(process.execPath, [substrateMjs, "merge", runId], { cwd: res.repoDir, encoding: "utf8" });
      expect(landed.status, `${landed.stdout}${landed.stderr}`).toBe(0);
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toContain("t1-done");
    } finally {
      res.cleanup();
    }
  });

  it("a task that fails for good is reported with one `failed` line", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q never-there src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("One failure", ["T1"]), { "tasks/T1.md": t1 })),
          ...Array.from({ length: 12 }, () => ({ reply: "DONE" })),
        ],
      },
      args: [...RUN_ARGS, "One failure"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const lines = res.stdout.split("\n").filter((l) => l.includes("[task T1] failed:"));
      expect(lines).toHaveLength(1);
    } finally {
      res.cleanup();
    }
  });

  // A failed run (T1 passed and merged into the run branch, T2 failed for good) lands its passed
  // part only through `merge --partial`, and only when integration verify passes on the run branch.
  // The plan's integration verify is `test ! -f <gate>`: it passes during the run (the gate file is
  // absent) and fails when the test puts the gate in place before a partial landing.
  function partialRun(gate: string) {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q never-there src/b.txt" });
    return runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Partial landing", ["T1", "T2"], `test ! -f ${gate}`), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
          ...Array.from({ length: 14 }, () => ({ reply: "DONE" })),
        ],
      },
      args: [...RUN_ARGS, "Partial landing"],
    });
  }

  it("a failed run names `merge --partial` next; plain merge refuses it; a verify that fails on the run branch lands nothing", () => {
    const gateDir = mkdtempSync(join(tmpdir(), "r82-gate-"));
    const gate = join(gateDir, "gate");
    const res = partialRun(gate);
    try {
      const runId = res.runDir?.split("/").at(-1) as string;
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain(`Next:       substrate merge ${runId} --partial  (lands the passed tasks after integration verify passes)`);
      const plain = spawnSync(process.execPath, [substrateMjs, "merge", runId], { cwd: res.repoDir, encoding: "utf8" });
      expect(plain.status).toBe(1);

      const headBefore = git(res.repoDir, ["rev-parse", "HEAD"]);
      writeFileSync(gate, "closed\n", "utf8");
      const partial = spawnSync(process.execPath, [substrateMjs, "merge", runId, "--partial"], { cwd: res.repoDir, encoding: "utf8" });
      expect(partial.status).toBe(1);
      expect(partial.stderr).toContain(`not merged: integration verify failed on the run branch: test ! -f ${gate}`);
      expect(git(res.repoDir, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(git(res.repoDir, ["worktree", "list", "--porcelain"])).not.toContain("partial-verify");
      expect(existsSync(join(res.repoDir, ".substrate", "worktrees", runId, "partial-verify"))).toBe(false);
    } finally {
      res.cleanup();
      rmSync(gateDir, { recursive: true, force: true });
    }
  });

  it("`merge --partial` lands the passed task once integration verify passes on the run branch", () => {
    const gateDir = mkdtempSync(join(tmpdir(), "r82-gate-"));
    const res = partialRun(join(gateDir, "gate"));
    try {
      const runId = res.runDir?.split("/").at(-1) as string;
      expect(res.exitCode).toBe(1);
      const partial = spawnSync(process.execPath, [substrateMjs, "merge", runId, "--partial"], { cwd: res.repoDir, encoding: "utf8" });
      expect(partial.status, `${partial.stdout}${partial.stderr}`).toBe(0);
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toContain("t1-done");
      expect(git(res.repoDir, ["show", "HEAD:src/b.txt"])).toBe("seed b");
    } finally {
      res.cleanup();
      rmSync(gateDir, { recursive: true, force: true });
    }
  });
});
