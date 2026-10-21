import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R10.4 (known issue 41, reversed): any run that did not finish is resumable. These tests run the built
// CLI through a failed run and its resume(s). Each round after the first gets its own scripted scenario,
// so a resume's worker calls are exactly the ones written for it.

const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };

type Ev = { type: string; data: any };

function runIdOf(res: RunSubstrateResult): string {
  return res.runDir?.split("/").at(-1) as string;
}

function eventsIn(runDir: string): Ev[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Runs the built CLI in the repo. `calls` gives the fake harness its scripted calls for this round only. */
function cli(repoDir: string, args: string[], calls?: unknown[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "substrate-resume-any-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.FAKE_SCENARIO_FILE;
  const scenarioDir = calls === undefined ? undefined : mkdtempSync(join(tmpdir(), "substrate-resume-any-scenario-"));
  if (calls !== undefined && scenarioDir !== undefined) {
    const file = join(scenarioDir, "scenario.json");
    writeFileSync(file, JSON.stringify({ calls }), "utf8");
    env.FAKE_SCENARIO_FILE = file;
  }
  try {
    const out = spawnSync(process.execPath, [substrateMjs, ...args], { cwd: repoDir, encoding: "utf8", env, timeout: 120000 });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (scenarioDir !== undefined) rmSync(scenarioDir, { recursive: true, force: true });
  }
}

const edit = (task: string, file: string, marker: string) => ({
  task,
  edits: { [file]: `seed ${file.slice(-5, -4)}\n${marker}\n` },
  reply: `${task} done\nDONE`,
});

/** T1 passes; T2 fails on each of its scripted calls; T3 depends on T2 and is skipped. */
function threeTaskFailure(): RunSubstrateResult {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  const t3 = taskSpec({ id: "T3", write: ["src/c.txt"], dependsOn: ["T2"], verify: "grep -q t3-done src/c.txt" });
  return runSubstrate({
    files: SEED,
    scenario: {
      calls: [
        planCall(contractFiles(manifestFor("Three", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
        edit("T1", "src/a.txt", "t1-done"),
        { task: "T2", reply: "DONE" },
        { task: "T2", reply: "DONE" },
      ],
    },
    args: [...RUN_ARGS, "Three tasks"],
  });
}

describe("R10.4: resume of a failed run retries the failed tasks, keeps the passed ones, and finishes", () => {
  it("T2 fails, resume retries it (the later call passes), T3 runs, T1 is not re-run, the run lands and finishes", () => {
    const res = threeTaskFailure();
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      const runDir = res.runDir as string;

      const out = cli(res.repoDir, ["resume", runId], [
        edit("T2", "src/b.txt", "t2-done"),
        edit("T3", "src/c.txt", "t3-done"),
      ]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain(`resuming failed run ${runId}: retrying T2; keeping T1 (passed)`);
      expect(out.stdout).toContain("skipped dependents return to the queue: T3");
      expect(out.stdout).toContain("finished: 3/3 passed");
      // The summary's Session ID is the run's own session, not an empty value.
      expect(out.stdout).toMatch(/Session ID: sess_\S+/);

      const events = eventsIn(runDir);
      const started = (task: string) => events.filter((e) => e.type === "task.session.started" && e.data.task_id === task).length;
      expect(started("T1")).toBe(1);
      expect(started("T2")).toBe(3);
      expect(started("T3")).toBe(1);
      const last = events.filter((e) => e.type === "run.finished").at(-1);
      expect(last?.data.exit_code).toBe(0);
      expect(events.some((e) => e.type === "run.reopened" && e.data.reason === "tasks")).toBe(true);

      expect(readFileSync(join(runDir, "progress.log"), "utf8")).toContain("# resumed");
      const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
      expect(result.status).toBe("finished");
      expect(readFileSync(join(runDir, "summary.txt"), "utf8")).toContain("finished");

      // The default landing merges the three tasks into the user's branch.
      expect(readFileSync(join(res.repoDir, "src/b.txt"), "utf8")).toContain("t2-done");
      expect(readFileSync(join(res.repoDir, "src/c.txt"), "utf8")).toContain("t3-done");
    } finally {
      res.cleanup();
    }
  });
});

describe("R10.4: a run that failed at the final integration verify re-runs only the verify", () => {
  it("resume runs no planner and no worker; a second failure says to fix the run branch; after the fix it lands", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Verify", ["T1", "T2"], "test -f READY.txt"), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          edit("T1", "src/a.txt", "t1-done"),
          edit("T2", "src/b.txt", "t2-done"),
        ],
      },
      args: [...RUN_ARGS, "Verify fails"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      const runDir = res.runDir as string;
      const before = eventsIn(runDir).length;

      // Nothing is fixed: no calls are scripted, so any spawn would fail the test.
      const again = cli(res.repoDir, ["resume", runId], []);
      expect(again.status).toBe(1);
      expect(again.stdout).toContain(`resuming failed run ${runId}: every task merged; integration verify runs again`);
      expect(again.stdout).toContain("runs integration verify again; fix the run branch first, then resume");
      const newEvents = eventsIn(runDir).slice(before);
      expect(newEvents.some((e) => e.type === "plan.started" || e.type === "task.session.started")).toBe(false);

      // The person fixes the run branch in a worktree, commits, and resumes.
      const wt = join(mkdtempSync(join(tmpdir(), "substrate-resume-any-wt-")), "fix");
      const git = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8" });
      expect(git(["worktree", "add", "-q", wt, `substrate/runs/${runId}`], res.repoDir).status).toBe(0);
      writeFileSync(join(wt, "READY.txt"), "ready\n", "utf8");
      git(["add", "READY.txt"], wt);
      expect(git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fix: READY"], wt).status).toBe(0);
      git(["worktree", "remove", "--force", wt], res.repoDir);

      const fixed = cli(res.repoDir, ["resume", runId], []);
      expect(fixed.status, fixed.stderr).toBe(0);
      expect(fixed.stdout).toContain("finished: 2/2 passed");
      expect(readFileSync(join(res.repoDir, "READY.txt"), "utf8")).toContain("ready");
    } finally {
      res.cleanup();
    }
  });
});

describe("R10.4: a run that failed in planning is planned again on resume", () => {
  it("the planner runs once more (one more spawn), names the cost, and the run finishes", () => {
    const badPlan = { plan: { files: { "manifest.yaml": "version: 1\nrun_id: r_X\n" } }, reply: "PLAN READY" };
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [badPlan, badPlan, badPlan] },
      args: [...RUN_ARGS, "Plan fails"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      expect(res.stdout).toContain(`Next:       substrate resume ${runId}  (plans again; planning costs again)`);
      const plansBefore = eventsIn(res.runDir as string).filter((e) => e.type === "plan.started").length;
      expect(plansBefore).toBe(1);

      const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
      const out = cli(res.repoDir, ["resume", runId], [
        planCall(contractFiles(manifestFor("Plan again", ["T1"]), { "tasks/T1.md": t1 })),
        edit("T1", "src/a.txt", "t1-done"),
      ]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("no plan was accepted; planning again (planning costs again)");
      expect(out.stdout).toContain("finished: 1/1 passed");
      const plansAfter = eventsIn(res.runDir as string).filter((e) => e.type === "plan.started").length;
      expect(plansAfter).toBe(plansBefore + 1);
    } finally {
      res.cleanup();
    }
  });
});

describe("R10.4: resume of a finished run that is not merged says how to land it", () => {
  it("a finished unmerged run prints already finished and the merge hint, with exit 0", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Unmerged", ["T1"]), { "tasks/T1.md": t1 })),
          edit("T1", "src/a.txt", "t1-done"),
        ],
      },
      args: [...RUN_ARGS, "--no-merge", "Unmerged run"],
    });
    try {
      expect(res.exitCode).toBe(0);
      const runId = runIdOf(res);
      const out = cli(res.repoDir, ["resume", runId]);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain(`Run ${runId} is already finished. Nothing to resume.`);
      expect(out.stdout).toContain(`not merged yet: substrate merge ${runId}`);
    } finally {
      res.cleanup();
    }
  });
});
