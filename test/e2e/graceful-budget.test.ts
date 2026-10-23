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

      // A passing run shows nothing about a base check, which no longer runs (R12.2), in any output.
      const base = /base (commit|check)|base_verify|integration verify also failed/;
      const runsOut = r.cli(["runs"]).stdout;
      const watchOut = r.cli(["watch", r.runId, "--no-follow"]).stdout;
      const summary = readFileSync(join(r.repo.dir, ".substrate", "runs", r.runId, "summary.txt"), "utf8");
      expect(text).not.toMatch(base);
      expect(runsOut).not.toMatch(base);
      expect(watchOut).not.toMatch(base);
      expect(summary).not.toMatch(base);
      // The integration check started with no base-check field (R12.2): no base check ran.
      expect(eventsOf(r.repo.dir, r.runId).find((e) => e.type === "integration.started")?.data).toEqual({});
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
