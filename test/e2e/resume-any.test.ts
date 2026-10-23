import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/** The argv of every invocation of the fake harness, from the record beside its scenario (R11.1); a prompt is one of its entries. */
function promptsLogged(scenario: string): string[] {
  const argvLog = `${scenario}.argv.jsonl`;
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => JSON.parse(l).argv as string[]);
}

function eventsIn(runDir: string): Ev[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Runs the built CLI in the repo. `calls` gives the fake harness its scripted calls for this round only. */
function cli(
  repoDir: string,
  args: string[],
  calls?: unknown[],
): { status: number | null; stdout: string; stderr: string; prompts: string[] } {
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
    // R11.1: the prompts the harness was given in this round, read before the scenario directory goes.
    const prompts = calls === undefined || scenarioDir === undefined ? [] : promptsLogged(join(scenarioDir, "scenario.json"));
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, prompts };
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
      // R11.1: the planning again is given the request the run was created with (the resume gave none).
      expect(readFileSync(join(res.runDir as string, "planner-request.md"), "utf8")).toContain("## Request\nPlan fails\n");
      expect(out.prompts.some((p) => p.includes("## Request\nPlan fails\n"))).toBe(true);
    } finally {
      res.cleanup();
    }
  });

  it("(e) a planning that fails again on resume keeps the request on every planner call, and the next resume plans with it", () => {
    const badPlan = { plan: { files: { "manifest.yaml": "version: 1\nrun_id: r_X\n" } }, reply: "PLAN READY" };
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [badPlan, badPlan, badPlan] },
      args: [...RUN_ARGS, "Plan twice fails"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      // The first resume's planner refuses every attempt again: the run fails again and stays resumable.
      const again = cli(res.repoDir, ["resume", runId], [badPlan, badPlan, badPlan]);
      expect(again.status).toBe(1);
      expect(again.stdout).toContain(`Next:       substrate resume ${runId}  (plans again; planning costs again)`);
      // The first attempt of each planning round carries the request; the correction attempts carry the diagnostics.
      expect(again.prompts.some((p) => p.includes("## Request\nPlan twice fails\n"))).toBe(true);

      const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
      const out = cli(res.repoDir, ["resume", runId], [
        planCall(contractFiles(manifestFor("Plan third time", ["T1"]), { "tasks/T1.md": t1 })),
        edit("T1", "src/a.txt", "t1-done"),
      ]);
      expect(out.prompts.some((p) => p.includes("## Request\nPlan twice fails\n"))).toBe(true);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("finished: 1/1 passed");
      expect(readFileSync(join(res.runDir as string, "planner-request.md"), "utf8")).toContain("## Request\nPlan twice fails\n");
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

// R10.5: the R10.4 cases that were not tested before. A process is held open with a marker or a scenario
// hang, and it is ended by its numeric pid. Every spawned process is killed in afterEach.

const liveChildren: ChildProcess[] = [];
const livePids: number[] = [];

afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  }
  for (const pid of livePids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function waitFor(check: () => boolean, label: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const tick = () => {
      if (check()) return done();
      if (Date.now() > deadline) return fail(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Starts the built CLI without waiting for it; the scenario file (if any) is its fake harness script. */
function startCli(repoDir: string, args: string[], scenarioPath?: string): ChildProcess {
  const home = mkdtempSync(join(tmpdir(), "substrate-resume-any-async-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.FAKE_SCENARIO_FILE;
  if (scenarioPath !== undefined) env.FAKE_SCENARIO_FILE = scenarioPath;
  const child = spawn(process.execPath, [substrateMjs, ...args], { cwd: repoDir, env, stdio: "ignore" });
  liveChildren.push(child);
  return child;
}

function scenarioAt(dir: string, calls: unknown[]): string {
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ calls }), "utf8");
  return file;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("R10.5: a task dropped for a merge conflict builds on top of the sibling after resume", () => {
  it("(b) two tasks write the same line; the one that conflicts is dropped; resume retries it on the run branch and the run finishes", () => {
    const trace = mkdtempSync(join(tmpdir(), "resume-any-trace-"));
    const A = taskSpec({ id: "A", write: ["src/a.txt"], verify: "grep -q A-line src/a.txt" });
    const B = taskSpec({ id: "B", write: ["src/a.txt"], verify: "grep -q B-line src/a.txt" });
    const union = "seed a\nA-line\nB-line\n";
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Conflict", ["A", "B"]), { "tasks/A.md": A, "tasks/B.md": B })),
          // Both workers finish before either merges, so the second merge collides with the first.
          { task: "A", edits: { "src/a.txt": "seed a\nA-line\n" }, reply: "A done\nDONE", trace: { dir: trace, name: "A", wait_for: ["B"], timeout_ms: 20000 } },
          { task: "B", edits: { "src/a.txt": "seed b\nB-line\n" }, reply: "B done\nDONE", trace: { dir: trace, name: "B", wait_for: ["A"], timeout_ms: 20000 } },
        ],
      },
      args: [...RUN_ARGS, "--concurrency", "2", "Conflict"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      const runDir = res.runDir as string;
      const dropped = eventsIn(runDir).find((e) => e.type === "task.failed" && e.data.failure_class === "merge_conflict");
      expect(dropped).toBeDefined();
      const droppedId = dropped?.data.task_id as string;
      const sibling = droppedId === "A" ? "B" : "A";

      // The retry starts from the run branch, which now holds the sibling's line; it writes both lines.
      const out = cli(res.repoDir, ["resume", runId], [
        { task: droppedId, edits: { "src/a.txt": union }, reply: "retry done\nDONE" },
        { task: sibling, edits: { "src/a.txt": union }, reply: "unused\nDONE" },
      ]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("finished:");
      const events = eventsIn(runDir);
      const started = (task: string) => events.filter((e) => e.type === "task.session.started" && e.data.task_id === task).length;
      expect(started(droppedId)).toBe(2);
      expect(started(sibling)).toBe(1);
      expect(events.filter((e) => e.type === "run.finished").at(-1)?.data.exit_code).toBe(0);
      expect(readFileSync(join(res.repoDir, "src/a.txt"), "utf8")).toBe(union);
    } finally {
      res.cleanup();
      rmSync(trace, { recursive: true, force: true });
    }
  });
});

describe("R10.5: a SIGKILL during the final-verify resume", () => {
  it("(c) the resumed verify is held and the CLI is killed; the next resume re-runs the verify and the run finishes", async () => {
    const work = mkdtempSync(join(tmpdir(), "resume-any-verify-"));
    const hold = join(work, "hold");
    const mark = join(work, "mark");
    const pidFile = join(work, "verify.pid");
    const ready = join(work, "ready");
    const script = join(work, "verify.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `if [ -f "${hold}" ]; then echo $$ > "${pidFile}"; touch "${mark}"; exec sleep 60; fi`,
        `if [ -f "${ready}" ]; then exit 0; fi`,
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    // Two tasks: a failed verify with two tasks names no culprit, so the resume re-runs only the verify.
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Verify kill", ["T1", "T2"], `sh ${script}`), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          edit("T1", "src/a.txt", "t1-done"),
          edit("T2", "src/b.txt", "t2-done"),
        ],
      },
      args: [...RUN_ARGS, "Verify kill"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      const runDir = res.runDir as string;

      // Hold the verify open, start the resume, and kill the CLI and the verify by pid while it runs.
      writeFileSync(hold, "", "utf8");
      const child = startCli(res.repoDir, ["resume", runId]);
      await waitFor(() => existsSync(pidFile), "the held verify");
      const verifyPid = Number(readFileSync(pidFile, "utf8"));
      livePids.push(verifyPid);
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      process.kill(verifyPid, "SIGKILL");
      await waitFor(() => !alive(verifyPid), "the held verify to end");
      rmSync(hold, { force: true });

      // The next resume re-runs only the verify: no worker is spawned, and the verify passes now.
      writeFileSync(ready, "", "utf8");
      const before = eventsIn(runDir).filter((e) => e.type === "task.session.started").length;
      const out = cli(res.repoDir, ["resume", runId], []);
      expect(out.status, out.stderr).toBe(0);
      const after = eventsIn(runDir).filter((e) => e.type === "task.session.started").length;
      expect(after).toBe(before);
      expect(eventsIn(runDir).filter((e) => e.type === "run.finished").at(-1)?.data.exit_code).toBe(0);
      expect(existsSync(mark)).toBe(true);
    } finally {
      res.cleanup();
      rmSync(work, { recursive: true, force: true });
    }
  }, 180000);
});

describe("R10.5: a SIGKILL during a resumed failed-run round, and the status words of a reopened run", () => {
  it("(g) the CLI is killed during the resumed retry; a second resume converges with no duplicate run of the passed task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-any-chaos-"));
    const res = threeTaskFailure();
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      const runDir = res.runDir as string;
      const scenario = scenarioAt(dir, [{ task: "T2", failure: "hang" }]);
      const child = startCli(res.repoDir, ["resume", runId], scenario);
      await waitFor(() => existsSync(`${scenario}.pid`), "the held retry");
      const workerPid = Number(readFileSync(`${scenario}.pid`, "utf8"));
      livePids.push(workerPid);
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      // The held worker ends by its pid; a stale worker is also ended by the next resume (R8.2).
      process.kill(workerPid, "SIGKILL");

      const out = cli(res.repoDir, ["resume", runId], [
        edit("T2", "src/b.txt", "t2-done"),
        edit("T3", "src/c.txt", "t3-done"),
      ]);
      expect(out.status, out.stderr).toBe(0);
      const events = eventsIn(runDir);
      const started = (task: string) => events.filter((e) => e.type === "task.session.started" && e.data.task_id === task).length;
      expect(started("T1")).toBe(1);
      expect(events.filter((e) => e.type === "run.finished").at(-1)?.data.exit_code).toBe(0);
      expect(readFileSync(join(res.repoDir, "src/c.txt"), "utf8")).toContain("t3-done");
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);

  it("status and runs show a reopened run as running while it goes, and as finished after; the earlier failure is not current", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-any-status-"));
    const res = threeTaskFailure();
    try {
      expect(res.exitCode).toBe(1);
      const runId = runIdOf(res);
      const scenario = scenarioAt(dir, [{ task: "T2", failure: "hang" }]);
      const child = startCli(res.repoDir, ["resume", runId], scenario);
      await waitFor(() => existsSync(`${scenario}.pid`), "the held retry");
      const workerPid = Number(readFileSync(`${scenario}.pid`, "utf8"));
      livePids.push(workerPid);

      const runsWhile = cli(res.repoDir, ["runs"]);
      expect(runsWhile.stdout).toMatch(new RegExp(`${runId}\\s+running`));
      const statusWhile = cli(res.repoDir, ["status", runId]);
      // The header names the run's state now; the failed count of the earlier run is not in this header.
      const headerWhile = statusWhile.stdout.split("\n")[0];
      expect(headerWhile).toMatch(new RegExp(`Run ${runId}\\s+running`));
      expect(headerWhile).not.toMatch(/failed/);

      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      process.kill(workerPid, "SIGKILL");

      const out = cli(res.repoDir, ["resume", runId], [
        edit("T2", "src/b.txt", "t2-done"),
        edit("T3", "src/c.txt", "t3-done"),
      ]);
      expect(out.status, out.stderr).toBe(0);
      const statusAfter = cli(res.repoDir, ["status", runId]);
      const headerAfter = statusAfter.stdout.split("\n")[0];
      expect(headerAfter).toMatch(new RegExp(`Run ${runId}\\s+finished`));
      expect(headerAfter).not.toMatch(/failed/);
      const runsAfter = cli(res.repoDir, ["runs"]);
      expect(runsAfter.stdout).toMatch(new RegExp(`${runId}\\s+finished`));
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});

