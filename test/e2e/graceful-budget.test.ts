import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R8.2 graceful: a run that spends its run budget stops, keeps the work that passed on the run
// branch, says what it spent and what each task was doing, and names the resume command with a
// higher budget. Nothing lands from it, and the resume finishes it.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku"];

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

function branchesOf(dir: string, prefix: string): string[] {
  return git(dir, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean);
}

function worktreesOf(dir: string): string[] {
  return git(dir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
}

function setup(repo: E2ERepo, scenarioPath: string, calls: unknown[]): { env: NodeJS.ProcessEnv; homeDir: string } {
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
  const homeDir = mkdtempSync(join(tmpdir(), "substrate-home-r82-"));
  return { env: { ...process.env, HOME: homeDir, FAKE_SCENARIO_FILE: scenarioPath }, homeDir };
}

describe("R8.2 graceful: budget exhaustion mid-run", () => {
  it("T1 passes, the run budget is spent by T2: T2 is interrupted, T1 stays on the run branch, and the resume names a higher budget", () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r82-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const planC = planCall(contractFiles(manifestFor("Budget", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 }));
    const t1Edit = { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE", cost_usd: 0.001 };
    const t2Edit = { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" };
    const { env, homeDir } = setup(repo, scenarioPath, [planC, t1Edit, { ...t2Edit, cost_usd: 0.05 }]);
    const headBefore = git(repo.dir, ["rev-parse", "HEAD"]);
    try {
      const stopped = spawnSync(process.execPath, [substrateMjs, ...RUN_ARGS, "--merge", "--max-budget-usd", "0.02", "Budget case"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1) as string;
      const out = stopped.stdout;
      expect(stopped.status, out.slice(-1500)).toBe(4);
      expect(out).toMatch(/Status:     paused/);
      expect(out).toMatch(/Reason:     budget_exhausted: spent \$0\.05\d+ of the \$0\.02 run budget; T1 passed, T2 interrupted/);
      expect(out).toContain(`Next:       substrate resume ${runId} --max-budget-usd 0.08`);
      expect(out).toContain("Merged:     no");

      // Nothing lands from a stopped run, even with the merge flag; the passed task stays on the run branch.
      expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(headBefore);
      const runRef = branchesOf(repo.dir, "refs/heads/substrate/runs/")[0];
      expect(git(repo.dir, ["show", `${runRef}:src/a.txt`])).toContain("t1-done");
      // A paused run keeps its task branches and worktrees, because resume needs them (R8.1).
      expect(branchesOf(repo.dir, "refs/heads/substrate/tasks/").map((b) => b.split("/").at(-1)).sort()).toEqual(["T1-g1", "T2-g1"]);
      expect(existsSync(join(repo.dir, ".substrate", "runs", runId, "events.jsonl"))).toBe(true);

      // Resume with a higher budget: T2 runs again (its worker is the next call), T1 is not run again.
      writeFileSync(scenarioPath, JSON.stringify({ calls: [planC, t1Edit, { ...t2Edit, cost_usd: 0.05 }, t2Edit] }), "utf8");
      const resumed = spawnSync(process.execPath, [substrateMjs, "resume", runId, "--max-budget-usd", "1"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      expect(resumed.status, `${resumed.stdout.slice(-1000)}\n${resumed.stderr.slice(-400)}`).toBe(0);
      const started = readFileSync(join(repo.dir, ".substrate", "runs", runId, "events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.includes('"task.session.started"'))
        .map((l) => JSON.parse(l).data.task_id);
      expect(started.filter((id) => id === "T1")).toHaveLength(1);
      expect(started.filter((id) => id === "T2").length).toBeGreaterThanOrEqual(2);
      expect(git(repo.dir, ["show", `${runRef}:src/b.txt`])).toContain("t2-done");
      expect(branchesOf(repo.dir, "refs/heads/substrate/tasks/")).toEqual([]);
      expect(worktreesOf(repo.dir)).toEqual([`worktree ${repo.dir}`]);
    } finally {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120000);
});

// R11.1: the run budget a run records (run.created) is the one its resumes use, and a resume that is given
// --max-budget-usd replaces it and records the new value on its resume event.
function statusOf(repoDir: string, env: NodeJS.ProcessEnv, runId: string): string {
  return spawnSync(process.execPath, [substrateMjs, "status", runId], { cwd: repoDir, encoding: "utf8", env, timeout: 120000 }).stdout;
}

/** Replaces a scenario's calls and forgets the calls the earlier round took (the harness keeps them in a state file). */
function scenarioReset(scenarioPath: string, calls: unknown[]): void {
  writeFileSync(scenarioPath, JSON.stringify({ calls }), "utf8");
  rmSync(`${scenarioPath}.state.json`, { force: true });
}

function eventsOf(repoDir: string, runId: string): Array<{ type: string; data: any }> {
  return readFileSync(join(repoDir, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("R11.1: the run budget is recorded and reused by a resume", () => {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  const planC = planCall(contractFiles(manifestFor("Budget record", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 }));
  const t1Edit = { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE", cost_usd: 0.3 };
  const t2Edit = { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE", cost_usd: 0.2 };

  it("status shows the recorded budget; a resume without the flag still stops at it; --max-budget-usd on the resume replaces it and is recorded", () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r111-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const { env, homeDir } = setup(repo, scenarioPath, [planC, t1Edit, t2Edit]);
    try {
      const stopped = spawnSync(process.execPath, [substrateMjs, ...RUN_ARGS, "--max-budget-usd", "0.40", "Budget record"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1) as string;
      expect(stopped.status, stopped.stdout.slice(-1500)).toBe(4);
      expect(eventsOf(repo.dir, runId).find((e) => e.type === "run.created")?.data.max_budget_usd).toBe(0.4);
      expect(statusOf(repo.dir, env, runId)).toMatch(/budget \$0\.40\)/);

      // No flag: the recorded 0.40 caps the resume, not the 5.00 project setting. The run stops again.
      scenarioReset(scenarioPath, [t2Edit]);
      const plain = spawnSync(process.execPath, [substrateMjs, "resume", runId], { cwd: repo.dir, env, encoding: "utf8", timeout: 120000 });
      expect(plain.status, plain.stdout.slice(-800)).toBe(4);
      expect(plain.stdout).toMatch(/of the \$0\.40 run budget/);

      // --max-budget-usd 1 replaces the recorded budget; the resume records 1 and finishes.
      scenarioReset(scenarioPath, [t2Edit]);
      const raised = spawnSync(process.execPath, [substrateMjs, "resume", runId, "--max-budget-usd", "1"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      expect(raised.status, `${raised.stdout.slice(-800)}\n${raised.stderr.slice(-400)}`).toBe(0);
      const resumes = eventsOf(repo.dir, runId).filter((e) => e.type === "run.resumed");
      expect(resumes.map((e) => e.data.max_budget_usd)).toEqual([0.4, 1]);
      expect(statusOf(repo.dir, env, runId)).toMatch(/budget \$1\.00\)/);
      expect(readFileSync(join(repo.dir, "src/b.txt"), "utf8")).toContain("t2-done");
    } finally {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 180000);

  it("status says each fact once: the paused word and reason, Phase paused, the resume as the next step, and costs with four decimals", () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r111-text-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const { env, homeDir } = setup(repo, scenarioPath, [planC, t1Edit, t2Edit]);
    try {
      const stopped = spawnSync(process.execPath, [substrateMjs, ...RUN_ARGS, "--max-budget-usd", "0.40", "Budget text"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1) as string;
      expect(stopped.status).toBe(4);
      const text = statusOf(repo.dir, env, runId);
      const header = text.split("\n")[0];
      expect(header).toMatch(new RegExp(`^Run ${runId}  paused: budget   elapsed`));
      expect(text).toContain("Phase:  paused");
      // R11.3: the resume command is named once, in Next:.
      expect(text).toContain("Process: none (paused)");
      expect(text).toContain(`Next:  substrate resume ${runId}`);
      expect(text).toMatch(/Cost \$\d+\.\d{4} \(budget \$0\.40\)/);
      // Each fact once: the legacy block no longer repeats the state, the reason, the cost or the run id.
      expect(text).not.toContain("State:");
      expect(text).not.toContain("Pause Reason:");
      expect(text).not.toContain("Total Cost:");
      expect(text).not.toContain("Run ID:");
      expect(text).not.toContain("the run has ended");
    } finally {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 180000);

  it("a run whose run.created has no max_budget_usd (an older log) shows and resumes with the project setting", () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r111-old-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const { env, homeDir } = setup(repo, scenarioPath, [planC, t1Edit, t2Edit]);
    try {
      const stopped = spawnSync(process.execPath, [substrateMjs, ...RUN_ARGS, "--max-budget-usd", "0.40", "Budget old log"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1) as string;
      expect(stopped.status).toBe(4);
      // Strip the field the way an older log lacks it.
      const eventsPath = join(repo.dir, ".substrate", "runs", runId, "events.jsonl");
      const lines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim());
      const stripped = lines.map((l) => {
        const ev = JSON.parse(l);
        if (ev.type === "run.created") delete ev.data.max_budget_usd;
        return JSON.stringify(ev);
      });
      writeFileSync(eventsPath, stripped.join("\n") + "\n", "utf8");
      expect(statusOf(repo.dir, env, runId)).toMatch(/budget \$5\.00\)/);

      scenarioReset(scenarioPath, [t2Edit]);
      const resumed = spawnSync(process.execPath, [substrateMjs, "resume", runId], { cwd: repo.dir, env, encoding: "utf8", timeout: 120000 });
      expect(resumed.status, `${resumed.stdout.slice(-800)}\n${resumed.stderr.slice(-400)}`).toBe(0);
    } finally {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 180000);
});

// Known issue 62 (R11.2): a worker the harness stops for its own budget records the spend on run.budget.exceeded,
// so the progress line and the event say what was spent, as the other budget stops do.
describe("R11.2: a budget kill by the harness records the spend", () => {
  it("run.budget.exceeded carries the spend the run recorded when the worker's own budget ends it", () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r112-kill-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const planK = planCall(contractFiles(manifestFor("Budget kill", ["T1"]), { "tasks/T1.md": t1 }));
    const { env, homeDir } = setup(repo, scenarioPath, [planK, { failure: "budget", cost_usd: 0.3, reply: "" }]);
    try {
      const stopped = spawnSync(process.execPath, [substrateMjs, ...RUN_ARGS, "Budget kill"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1) as string;
      expect(stopped.status, stopped.stdout.slice(-800)).toBe(4);
      const exceeded = eventsOf(repo.dir, runId).filter((e) => e.type === "run.budget.exceeded");
      expect(exceeded.length).toBeGreaterThan(0);
      const data = exceeded.at(-1)?.data as { cost_usd?: number; max_usd?: number };
      // The fake harness reports 0.3 plus its own small per-call cost, so the spend is a little above 0.3.
      expect(data.cost_usd).toBeGreaterThan(0.29);
      expect(data.cost_usd).toBeLessThan(0.31);
      expect(stopped.stdout).toMatch(/budget exceeded: spent \$0\.30\d\d/);
    } finally {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120000);
});

// R11.3: the text of `status`, `runs`, `watch` and summary.txt after a run ends, and while it is planned.
describe("R11.3: status names one next step and one task list", () => {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  // The integration verify checks the first task's edit, so it fails on the base commit and passes on the run branch.
  const planC = planCall(
    contractFiles(manifestFor("Polish", ["T1", "T2"], "grep -q t1-done src/a.txt"), { "tasks/T1.md": t1, "tasks/T2.md": t2 }),
  );
  const t1Edit = { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" };
  const t2Edit = { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" };

  function runOnce(args: string[], calls: unknown[]) {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r113-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const { env, homeDir } = setup(repo, scenarioPath, calls);
    const ran = spawnSync(process.execPath, [substrateMjs, ...RUN_ARGS, ...args], { cwd: repo.dir, env, encoding: "utf8", timeout: 120000 });
    const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1) as string;
    const cleanup = () => {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    };
    const cli = (cmd: string[]) => spawnSync(process.execPath, [substrateMjs, ...cmd], { cwd: repo.dir, encoding: "utf8", env, timeout: 120000 });
    return { ran, runId, repo, cleanup, cli };
  }

  it("a finished run that merged: no Next line in text, json next is [], one row per task, and no base-check mention", () => {
    const r = runOnce(["Finished merged"], [planC, t1Edit, t2Edit]);
    try {
      expect(r.ran.status, r.ran.stdout.slice(-800)).toBe(0);
      const text = r.cli(["status", r.runId]).stdout;
      expect(text).not.toMatch(/^Next:/m);
      expect(text).toContain("Process: none (the run has ended)");
      expect(text).toContain("Tasks: 2 passed, 0 running, 0 failed, 0 waiting");
      expect(text.match(/^ {2}T1 /gm)).toHaveLength(1);
      expect(text.match(/^ {2}T2 /gm)).toHaveLength(1);
      expect(text).toMatch(/^ {2}T1 .*passed/m);
      expect(text).not.toContain("=== Run Status ===");
      expect(text).not.toMatch(/PENDING|MERGED/);
      const json = JSON.parse(r.cli(["status", r.runId, "--output-format", "json"]).stdout);
      expect(json.status).toBe("finished");
      expect(json.next).toEqual([]);

      // A passing run shows nothing about the base check (R11.3), in any output.
      const base = /base (commit|check)|base_verify|integration verify also failed/;
      const runsOut = r.cli(["runs"]).stdout;
      const watchOut = r.cli(["watch", r.runId, "--no-follow"]).stdout;
      const summary = readFileSync(join(r.repo.dir, ".substrate", "runs", r.runId, "summary.txt"), "utf8");
      expect(text).not.toMatch(base);
      expect(runsOut).not.toMatch(base);
      expect(watchOut).not.toMatch(base);
      expect(summary).not.toMatch(base);
      // The field is in the log (the base check ran and failed), and the text does not show it.
      expect(eventsOf(r.repo.dir, r.runId).find((e) => e.type === "integration.started")?.data).toEqual({ base_verify_passed: false });
    } finally {
      r.cleanup();
    }
  }, 180000);

  it("a finished run that did not merge (--no-merge) names substrate merge in text and json", () => {
    const r = runOnce(["--no-merge", "Finished unmerged"], [planC, t1Edit, t2Edit]);
    try {
      expect(r.ran.status, r.ran.stdout.slice(-800)).toBe(0);
      const text = r.cli(["status", r.runId]).stdout;
      expect(text).toContain(`Next:  substrate merge ${r.runId}`);
      expect(text).not.toContain("substrate watch");
      expect(text.match(/^Next:/gm)).toHaveLength(1);
      const json = JSON.parse(r.cli(["status", r.runId, "--output-format", "json"]).stdout);
      expect(json.status).toBe("finished");
      expect(json.next).toEqual([`substrate merge ${r.runId}`]);
    } finally {
      r.cleanup();
    }
  }, 180000);

  it("a planned run shows its tasks once, as waiting, and names the resume", () => {
    const r = runOnce(["--review", "Planned waiting"], [planC]);
    try {
      expect(r.ran.status, r.ran.stdout.slice(-800)).toBe(0);
      const text = r.cli(["status", r.runId]).stdout;
      expect(text).toContain("Tasks: 0 passed, 0 running, 0 failed, 2 waiting");
      expect(text.match(/^ {2}T1 .*waiting/gm)).toHaveLength(1);
      expect(text.match(/^ {2}T2 .*waiting/gm)).toHaveLength(1);
      expect(text).not.toMatch(/PENDING/);
      expect(text).not.toContain("=== Run Status ===");
      expect(text).toContain(`Next:  substrate resume ${r.runId}`);
      expect(text).not.toContain("substrate watch");
    } finally {
      r.cleanup();
    }
  }, 180000);
});
