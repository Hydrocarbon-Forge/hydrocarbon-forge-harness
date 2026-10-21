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
