import { describe, it, expect } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runSubstrate } from "./helpers/run-substrate.js";
import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R10.1: a finished run merges into the user's branch by default. Each test runs the built CLI
// against the fake harnesses in a scratch repository. The held runs use the fake harness's trace
// barrier: a worker waits until the test writes start-GATE.json, so the test can change the user's
// checkout while the run is working.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "README.md": "# user's readme\n", "contracts/types.ts": CONTRACT_STUB };

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function gitStatus(dir: string): string {
  return git(dir, ["status", "--porcelain", "--untracked-files=no"]);
}

function runIdOf(stdout: string): string {
  const id = /Run ID:\s+(\S+)/.exec(stdout)?.[1];
  if (id === undefined) throw new Error(`no Run ID in output:\n${stdout}`);
  return id;
}

function substrate(dir: string, args: string[]) {
  return spawnSync(process.execPath, [substrateMjs, ...args], { cwd: dir, encoding: "utf8" });
}

/** Two tasks on two files: T1 writes src/a.txt, T2 writes src/b.txt. */
function twoTaskCalls(): unknown[] {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  return [
    planCall(contractFiles(manifestFor("Two files", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
    { task: "T1", edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
    { task: "T2", edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" },
  ];
}

/** One task on src/a.txt, the only call the held runs make. */
function oneTaskCalls(barrier?: { dir: string; gate: string }): unknown[] {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const trace = barrier ? { trace: { dir: barrier.dir, name: "T1", wait_for: [barrier.gate], timeout_ms: 60000 } } : {};
  return [
    planCall(contractFiles(manifestFor("One file", ["T1"]), { "tasks/T1.md": t1 })),
    { task: "T1", ...trace, edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
  ];
}

// ---- held runs: the run is started asynchronously and released by the test ----

interface HeldRun {
  repo: E2ERepo;
  barrier: string;
  home: string;
  scenarioDir: string;
  /** Resolves once the run has exited, with its status and output. */
  done: Promise<{ status: number | null; stdout: string; stderr: string }>;
  child: ChildProcess;
}

/** Starts a run whose T1 worker is held at the barrier until the test writes start-GATE.json. */
function startHeldRun(files: Record<string, string>, calls: (barrier: { dir: string; gate: string }) => unknown[]): HeldRun {
  const repo = createE2ERepo(files);
  const barrier = mkdtempSync(join(tmpdir(), "substrate-r101-barrier-"));
  const home = mkdtempSync(join(tmpdir(), "substrate-r101-home-"));
  const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-r101-scenario-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ calls: calls({ dir: barrier, gate: "GATE" }) }), "utf8");
  mkdirSync(join(repo.dir, ".substrate"), { recursive: true });
  writeFileSync(
    join(repo.dir, ".substrate", "settings.json"),
    JSON.stringify({
      backends: { claude: { bin: join(binDir, "claude") }, opencode: { bin: join(binDir, "opencode") }, agy: { bin: join(binDir, "agy") } },
      concurrency: { workers: 1 },
    }),
    "utf8",
  );
  const child = spawn(
    process.execPath,
    [substrateMjs, "run", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions", "Held run"],
    { cwd: repo.dir, env: { ...process.env, HOME: home, FAKE_SCENARIO_FILE: scenarioPath }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d));
  child.stderr?.on("data", (d) => (stderr += d));
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveDone) => {
    child.on("exit", (status) => resolveDone({ status, stdout, stderr }));
  });
  return { repo, barrier, home, scenarioDir, done, child };
}

/** Waits until the held run's T1 worker has started, so the run is working. */
async function untilWorking(held: HeldRun): Promise<void> {
  const marker = join(held.barrier, "start-T1.json");
  const deadline = Date.now() + 60000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error("the held run never started its worker");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function release(held: HeldRun): void {
  writeFileSync(join(held.barrier, "start-GATE.json"), JSON.stringify({ pid: 0, at: Date.now() }), "utf8");
}

function cleanupHeld(held: HeldRun): void {
  held.repo.cleanup();
  rmSync(held.barrier, { recursive: true, force: true });
  rmSync(held.home, { recursive: true, force: true });
  rmSync(held.scenarioDir, { recursive: true, force: true });
}

describe("R10.1: a finished run merges into the user's branch by default", () => {
  it("(a) default: two tasks land on the user's branch, the checkout is clean, and only the run branch is left", () => {
    const res = runSubstrate({ files: SEED, scenario: { calls: twoTaskCalls() }, args: [...RUN_ARGS, "Two files"] });
    try {
      const runId = runIdOf(res.stdout);
      expect(res.exitCode, res.stdout.slice(-1500)).toBe(0);
      expect(res.stdout).toContain("Merged:     yes\n");
      expect(res.stdout).toContain("Merged into main (working tree updated)\n");
      expect(res.stdout).toMatch(/\] merged into main\n/);
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toContain("t1-done");
      expect(git(res.repoDir, ["show", "HEAD:src/b.txt"])).toContain("t2-done");
      expect(gitStatus(res.repoDir)).toBe("");
      // The run branch stays; no task branch or task worktree is left behind.
      const branches = git(res.repoDir, ["branch", "--format=%(refname:short)"]).split("\n");
      expect(branches.filter((b) => b.startsWith("substrate/") && b !== `substrate/runs/${runId}`)).toEqual([]);
      expect(branches).toContain(`substrate/runs/${runId}`);
      expect(git(res.repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    } finally {
      res.cleanup();
    }
  });

  it("(b) --no-merge: the user's branch is untouched, and `substrate merge <id>` lands the run afterwards", () => {
    const res = runSubstrate({ files: SEED, scenario: { calls: twoTaskCalls() }, args: [...RUN_ARGS, "--no-merge", "Two files"] });
    try {
      const runId = runIdOf(res.stdout);
      expect(res.exitCode, res.stdout.slice(-1500)).toBe(0);
      const headBefore = git(res.repoDir, ["rev-parse", "HEAD"]);
      expect(res.stdout).toContain("Merged:     no\n");
      expect(res.stdout).toContain(`Result:     finished: work is on branch substrate/runs/${runId}, not merged (merging was turned off)\n`);
      expect(res.stdout).toContain(`Next:       substrate merge ${runId}\n`);
      expect(res.stdout).not.toMatch(/\] merged into main\n/);
      expect(res.stdout).toMatch(/\] not merged: merging was turned off\n/);
      expect(git(res.repoDir, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(gitStatus(res.repoDir)).toBe("");
      expect(existsSync(join(res.repoDir, "src", "a.txt"))).toBe(true);
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");

      const merged = substrate(res.repoDir, ["merge", runId]);
      expect(merged.status, `${merged.stdout}${merged.stderr}`).toBe(0);
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toContain("t1-done");
      expect(git(res.repoDir, ["show", "HEAD:src/b.txt"])).toContain("t2-done");
    } finally {
      res.cleanup();
    }
  });

  it("(c) a request with merge: false keeps the run on its branch", () => {
    const request = JSON.stringify({
      goal: "Two files",
      planner: { provider: "claude", model: "claude-sonnet-5-5" },
      worker: { provider: "claude", model: "haiku" },
      merge: false,
    });
    const res = runSubstrate({ files: SEED, scenario: { calls: twoTaskCalls() }, args: ["run", "--request", "-", "--permission-mode", "bypassPermissions"], stdin: request });
    try {
      expect(res.exitCode, res.stdout.slice(-1500)).toBe(0);
      expect(res.stdout).toContain("Merged:     no\n");
      expect(res.stdout).toContain("(merging was turned off)\n");
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");
    } finally {
      res.cleanup();
    }
  });

  it("(d) the project setting git.auto_merge: false is honoured, and --merge overrides it for one run", () => {
    const off = runSubstrate({ files: SEED, settings: { git: { auto_merge: false } }, scenario: { calls: twoTaskCalls() }, args: [...RUN_ARGS, "Two files"] });
    try {
      expect(off.exitCode, off.stdout.slice(-1500)).toBe(0);
      expect(off.stdout).toContain("Merged:     no\n");
      expect(git(off.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");
    } finally {
      off.cleanup();
    }
    const forced = runSubstrate({ files: SEED, settings: { git: { auto_merge: false } }, scenario: { calls: twoTaskCalls() }, args: [...RUN_ARGS, "--merge", "Two files"] });
    try {
      expect(forced.exitCode, forced.stdout.slice(-1500)).toBe(0);
      expect(forced.stdout).toContain("Merged:     yes\n");
      expect(git(forced.repoDir, ["show", "HEAD:src/a.txt"])).toContain("t1-done");
    } finally {
      forced.cleanup();
    }
  });

  it("(e) a dirty checkout refuses the landing: exit 1, the named message, then a clean checkout and `substrate merge` lands it", () => {
    const res = runSubstrate({
      files: SEED,
      beforeRun: (repo) => writeFileSync(join(repo.dir, "README.md"), "# user is editing this\n", "utf8"),
      scenario: { calls: twoTaskCalls() },
      args: [...RUN_ARGS, "Two files"],
    });
    try {
      const runId = runIdOf(res.stdout);
      expect(res.exitCode, res.stdout.slice(-1500)).toBe(1);
      expect(res.stdout).toContain("Status:     finished\n");
      expect(res.stdout).toContain("Merged:     no\n");
      expect(res.stdout).toContain(
        `not merged: your working tree has uncommitted changes; commit or stash them, then run: substrate merge ${runId}\n`,
      );
      expect(res.stdout).not.toContain("Reason:");
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");

      writeFileSync(join(res.repoDir, "README.md"), "# user's readme\n", "utf8");
      expect(gitStatus(res.repoDir)).toBe("");
      const landed = substrate(res.repoDir, ["merge", runId]);
      expect(landed.status, `${landed.stdout}${landed.stderr}`).toBe(0);
      expect(git(res.repoDir, ["show", "HEAD:src/b.txt"])).toContain("t2-done");
    } finally {
      res.cleanup();
    }
  });

  it("(f) the user switched branches while the run worked: not merged, and the message names both branches", async () => {
    const held = startHeldRun(SEED, oneTaskCalls);
    try {
      await untilWorking(held);
      // The user moves to another branch while the worker is held; the run's worktrees are not in the checkout.
      git(held.repo.dir, ["switch", "-c", "other"]);
      release(held);
      const res = await held.done;
      expect(res.status, res.stdout.slice(-1500)).toBe(1);
      const runId = runIdOf(res.stdout);
      expect(res.stdout).toContain("Status:     finished\n");
      expect(res.stdout).toContain("Merged:     no\n");
      expect(res.stdout).toContain(
        `not merged: you switched from main to other while the run was working; check out main and run: substrate merge ${runId}\n`,
      );
      expect(git(held.repo.dir, ["branch", "--show-current"])).toBe("other");
      expect(git(held.repo.dir, ["show", "HEAD:src/a.txt"])).toBe("seed a");
      expect(gitStatus(held.repo.dir)).toBe("");

      // Back on main, the explicit merge lands the run.
      git(held.repo.dir, ["switch", "main"]);
      const landed = substrate(held.repo.dir, ["merge", runId]);
      expect(landed.status, `${landed.stdout}${landed.stderr}`).toBe(0);
      expect(git(held.repo.dir, ["show", "HEAD:src/a.txt"])).toContain("t1-done");
    } finally {
      cleanupHeld(held);
    }
  }, 120000);

  it("(g) a failed run never merges, even by default: exit 1, the user's branch untouched", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q never-there src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("One failure", ["T1"]), { "tasks/T1.md": t1 })),
          ...Array.from({ length: 14 }, () => ({ reply: "DONE" })),
        ],
      },
      args: [...RUN_ARGS, "One failure"],
    });
    try {
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("Merged:     no\n");
      expect(res.stdout).not.toMatch(/merged into/);
      expect(git(res.repoDir, ["rev-parse", "HEAD"])).toBe(git(res.repoDir, ["rev-parse", "main"]));
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");
    } finally {
      res.cleanup();
    }
  });

  it("(g2) a partial run (one task passed, one failed) never merges by default", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q never-there src/b.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Partial", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          { task: "T1", edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
          ...Array.from({ length: 14 }, () => ({ task: "T2", reply: "DONE" })),
        ],
      },
      args: [...RUN_ARGS, "Partial"],
    });
    try {
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("Merged:     no\n");
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");
    } finally {
      res.cleanup();
    }
  });

  it("(h) `substrate plan` never merges", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [planCall(contractFiles(manifestFor("Plan only", ["T1"]), { "tasks/T1.md": taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" }) }))],
      },
      args: ["plan", "--plan", "claude:claude-sonnet-5-5", "--permission-mode", "bypassPermissions", "Plan only"],
    });
    try {
      expect(res.exitCode, res.stdout.slice(-1500)).toBe(0);
      expect(res.stdout).not.toMatch(/merged into/);
      expect(res.stdout).not.toContain("Merged:     yes");
      expect(git(res.repoDir, ["show", "HEAD:src/a.txt"])).toBe("seed a");
      expect(gitStatus(res.repoDir)).toBe("");
    } finally {
      res.cleanup();
    }
  });

  it("(i) a conflict at landing is graceful: not merged, the files named, no MERGE_HEAD or markers, the user's branch and the run branch intact", async () => {
    const held = startHeldRun(SEED, oneTaskCalls);
    try {
      await untilWorking(held);
      // The user commits a change to the same file on their branch; their tree is clean, so the guard passes.
      writeFileSync(join(held.repo.dir, "src", "a.txt"), "seed a\nuser-change\n", "utf8");
      git(held.repo.dir, ["add", "src/a.txt"]);
      git(held.repo.dir, ["commit", "-m", "user edits a.txt"]);
      const userHead = git(held.repo.dir, ["rev-parse", "HEAD"]);
      release(held);
      const res = await held.done;
      expect(res.status, res.stdout.slice(-1500)).toBe(1);
      const runId = runIdOf(res.stdout);
      expect(res.stdout).toContain("Status:     finished\n");
      expect(res.stdout).toContain("Merged:     no\n");
      expect(res.stdout).toMatch(/not merged: the run's changes conflict with your branch in src\/a\.txt; resolve them, then run: substrate merge /);
      expect(res.stdout).toContain(`substrate merge ${runId}`);
      expect(git(held.repo.dir, ["rev-parse", "HEAD"])).toBe(userHead);
      expect(spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: held.repo.dir }).status).not.toBe(0);
      expect(readFileSync(join(held.repo.dir, "src", "a.txt"), "utf8")).toBe("seed a\nuser-change\n");
      expect(gitStatus(held.repo.dir)).toBe("");
      expect(git(held.repo.dir, ["branch", "--list", `substrate/runs/${runId}`])).toContain(`substrate/runs/${runId}`);
    } finally {
      cleanupHeld(held);
    }
  }, 120000);
});
