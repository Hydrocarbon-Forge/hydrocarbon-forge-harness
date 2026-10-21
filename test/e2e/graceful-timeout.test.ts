import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R11.2 (known issue 60): `--timeout <seconds>` is the run's wall-clock limit. When it is reached the run stops
// as a budget stop does: the in-flight worker or planner is killed, nothing new merges, the task worktrees are
// kept, and the run is paused with reason timeout (exit 4). A resume reuses the recorded limit, or takes a new one.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku"];

// A held session: the fake harness writes its pid to `<scenario>.pid` and never returns (the marker file).
const HOLD = { failure: "hang" };

const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
const planC = planCall(contractFiles(manifestFor("Timeout", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 }));
const t1Edit = { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" };
const t2Edit = { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" };

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

function branchesOf(dir: string, prefix: string): string[] {
  return git(dir, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean);
}

function worktreesOf(dir: string): string[] {
  return git(dir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
}

interface Case {
  repo: E2ERepo;
  scenarioDir: string;
  scenarioPath: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  cleanup(): void;
}

function openCase(label: string, calls: unknown[]): Case {
  const repo = createE2ERepo(SEED);
  const scenarioDir = mkdtempSync(join(tmpdir(), `substrate-scenario-r112-${label}-`));
  const scenarioPath = join(scenarioDir, "scenario.json");
  mkdirSync(join(repo.dir, ".substrate"), { recursive: true });
  writeFileSync(
    join(repo.dir, ".substrate", "settings.json"),
    JSON.stringify({
      backends: { claude: { bin: join(binDir, "claude") }, opencode: { bin: join(binDir, "opencode") }, agy: { bin: join(binDir, "agy") } },
      concurrency: { workers: 1 },
    }),
    "utf8",
  );
  writeFileSync(scenarioPath, JSON.stringify({ calls }), "utf8");
  const homeDir = mkdtempSync(join(tmpdir(), "substrate-home-r112-"));
  return {
    repo,
    scenarioDir,
    scenarioPath,
    env: { ...process.env, HOME: homeDir, FAKE_SCENARIO_FILE: scenarioPath },
    homeDir,
    cleanup() {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

/** Replaces a scenario's calls and forgets the calls the earlier round took (the harness keeps them in a state file). */
function scenarioReset(scenarioPath: string, calls: unknown[]): void {
  writeFileSync(scenarioPath, JSON.stringify({ calls }), "utf8");
  rmSync(`${scenarioPath}.state.json`, { force: true });
}

function cli(c: Case, args: string[], cwd = c.repo.dir): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [substrateMjs, ...args], { cwd, env: c.env, encoding: "utf8", timeout: 120000 });
}

function runIdOf(c: Case): string {
  return readdirSync(join(c.repo.dir, ".substrate", "runs")).sort().at(-1) as string;
}

function eventsOf(repoDir: string, runId: string): Array<{ type: string; data: any; ts: string }> {
  return readFileSync(join(repoDir, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** True when a process is alive and not a zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/\) Z /.test(stat);
  } catch {
    return false;
  }
}

function heldPid(scenarioPath: string): number {
  return Number(readFileSync(`${scenarioPath}.pid`, "utf8").trim());
}

describe("R11.2: --timeout stops a run at its wall-clock limit", () => {
  it("a held worker is stopped at the limit: exit 4, paused with reason timeout, the worker gone, no merge, the worktrees kept, and the resume names a longer limit", () => {
    const c = openCase("hold", [planC, HOLD]);
    try {
      const started = Date.now();
      const stopped = cli(c, [...RUN_ARGS, "--merge", "--timeout", "3", "Timeout hold"]);
      const elapsedMs = Date.now() - started;
      const runId = runIdOf(c);
      const out = stopped.stdout;
      expect(stopped.status, out.slice(-1500)).toBe(4);
      expect(elapsedMs).toBeLessThan(15000);
      expect(out).toMatch(/Status:     paused/);
      expect(out).toContain("run paused: timeout (3s limit reached)");
      expect(out).toContain("Reason:     timeout: the run reached its 3s time limit; T1 interrupted, T2 not started");
      expect(out).toContain(`Next:       substrate resume ${runId} --timeout 6`);
      expect(out).toContain("Merged:     no");

      // The held worker is gone: the run killed it with its process group.
      expect(alive(heldPid(c.scenarioPath))).toBe(false);
      // The user's tree is untouched and nothing merged.
      expect(git(c.repo.dir, ["status", "--porcelain"])).toBe("");
      expect(readFileSync(join(c.repo.dir, "src/a.txt"), "utf8")).toBe("seed a\n");
      expect(git(c.repo.dir, ["rev-parse", "HEAD"])).toBe(git(c.repo.dir, ["rev-parse", "main"]));
      // A paused run keeps its task branch and worktree for the resume.
      expect(branchesOf(c.repo.dir, "refs/heads/substrate/tasks/").map((b) => b.split("/").at(-1))).toEqual(["T1-g1"]);
      expect(worktreesOf(c.repo.dir).length).toBeGreaterThan(1);

      const events = eventsOf(c.repo.dir, runId);
      expect(events.find((e) => e.type === "run.created")?.data.time_limit_s).toBe(3);
      const paused = events.filter((e) => e.type === "run.paused").at(-1);
      expect(paused?.data).toMatchObject({ reason: "timeout", time_limit_s: 3 });
    } finally {
      c.cleanup();
    }
  }, 120000);

  it("a resume without --timeout reuses the recorded limit and stops at it again; a resume with a larger --timeout, the worker released, finishes and lands", () => {
    const c = openCase("resume", [planC, HOLD]);
    try {
      const first = cli(c, [...RUN_ARGS, "--merge", "--timeout", "3", "Timeout resume"]);
      expect(first.status).toBe(4);
      const runId = runIdOf(c);

      // No flag: the recorded 3 s limit applies to the fresh clock, and the held worker stops it again.
      scenarioReset(c.scenarioPath, [HOLD]);
      const again = cli(c, ["resume", runId]);
      expect(again.status, again.stdout.slice(-800)).toBe(4);
      expect(again.stdout).toContain("run paused: timeout (3s limit reached)");
      expect(eventsOf(c.repo.dir, runId).filter((e) => e.type === "run.resumed").map((e) => e.data.time_limit_s)).toEqual([3]);
      expect(alive(heldPid(c.scenarioPath))).toBe(false);

      // A larger limit, and the worker released: T1 passes, T2 runs, and the run lands.
      scenarioReset(c.scenarioPath, [t1Edit, t2Edit]);
      const started = Date.now();
      const finished = cli(c, ["resume", runId, "--timeout", "600"]);
      expect(finished.status, `${finished.stdout.slice(-800)}\n${finished.stderr.slice(-400)}`).toBe(0);
      expect(Date.now() - started).toBeLessThan(120000);
      expect(readFileSync(join(c.repo.dir, "src/a.txt"), "utf8")).toContain("t1-done");
      expect(readFileSync(join(c.repo.dir, "src/b.txt"), "utf8")).toContain("t2-done");
      expect(eventsOf(c.repo.dir, runId).filter((e) => e.type === "run.resumed").map((e) => e.data.time_limit_s)).toEqual([3, 600]);
      expect(branchesOf(c.repo.dir, "refs/heads/substrate/tasks/")).toEqual([]);
    } finally {
      c.cleanup();
    }
  }, 180000);

  it("a planning-phase timeout stops the planner process; a resume plans again with the request kept", () => {
    // The first call is the planner's and is held.
    const c = openCase("plan", [HOLD]);
    try {
      const stopped = cli(c, [...RUN_ARGS, "--timeout", "3", "Timeout plan request"]);
      const runId = runIdOf(c);
      expect(stopped.status, stopped.stdout.slice(-800)).toBe(4);
      expect(stopped.stdout).toContain("run paused: timeout (3s limit reached)");
      expect(stopped.stdout).toContain("Reason:     timeout: the run reached its 3s time limit");
      expect(alive(heldPid(c.scenarioPath))).toBe(false);
      expect(existsSync(join(c.repo.dir, ".substrate", "runs", runId, "manifest.yaml"))).toBe(false);

      // The resume plans again: the planner gets the original request, and the finished run takes the longer limit.
      scenarioReset(c.scenarioPath, [planC, t1Edit, t2Edit]);
      const resumed = cli(c, ["resume", runId, "--timeout", "600"]);
      expect(resumed.status, `${resumed.stdout.slice(-800)}\n${resumed.stderr.slice(-400)}`).toBe(0);
      const argv = readFileSync(`${c.scenarioPath}.argv.jsonl`, "utf8");
      expect(argv).toContain("Timeout plan request");
      const types = eventsOf(c.repo.dir, runId).map((e) => e.type);
      expect(types).toContain("run.reopened");
      // R11.3: planning stopped before any plan existed, and the resume says so.
      expect(resumed.stdout).toContain("planning was cut short before a plan was produced; planning again (planning costs again)");
      expect(readFileSync(join(c.repo.dir, "src/a.txt"), "utf8")).toContain("t1-done");
    } finally {
      c.cleanup();
    }
  }, 180000);

  it("a limit that is not reached changes nothing: the run finishes, exits 0 and the process exits promptly (no leaked timer)", () => {
    const c = openCase("fast", [planC, t1Edit, t2Edit]);
    try {
      const started = Date.now();
      const done = cli(c, [...RUN_ARGS, "--merge", "--timeout", "600", "Timeout fast"]);
      const elapsedMs = Date.now() - started;
      expect(done.status, `${done.stdout.slice(-800)}\n${done.stderr.slice(-400)}`).toBe(0);
      // spawnSync returns only when the process has exited; a timer left running would hold it for 600 s.
      expect(elapsedMs).toBeLessThan(120000);
      expect(done.stdout).not.toContain("timeout");
      expect(readFileSync(join(c.repo.dir, "src/b.txt"), "utf8")).toContain("t2-done");
      expect(eventsOf(c.repo.dir, runIdOf(c)).find((e) => e.type === "run.created")?.data.time_limit_s).toBe(600);
    } finally {
      c.cleanup();
    }
  }, 180000);

  it("a value that is not a whole number of seconds, 1 or more, exits 2 before anything runs", () => {
    const c = openCase("invalid", [planC]);
    try {
      for (const bad of ["0", "-5", "1.5", "abc"]) {
        const res = cli(c, [...RUN_ARGS, "--timeout", bad, "Timeout invalid"]);
        expect(res.status, `--timeout ${bad}`).toBe(2);
        expect(res.stderr, `--timeout ${bad}`).toContain("--timeout must be a whole number of seconds, 1 or more");
      }
      expect(existsSync(join(c.repo.dir, ".substrate", "runs"))).toBe(false);
    } finally {
      c.cleanup();
    }
  }, 120000);
});
