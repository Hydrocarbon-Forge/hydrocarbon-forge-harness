import { describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R10.2: a run's status is visible from outside the process that runs it. These tests drive the
// built CLI (dist/substrate.mjs) against the fake harness. A worker that waits on a gate session
// holds the run until the test writes that gate's start marker, so every observation is taken
// while the run is live, not after it has ended.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");
const PLAN_SEED = {
  "src/t1.txt": "seed t1\n",
  "src/t3.txt": "seed t3\n",
  "contracts/types.ts": CONTRACT_STUB,
};
const SOLO_RUN = ["run", "--mode", "solo", "--work", "claude:haiku", "--permission-mode", "bypassPermissions"];
const PLAN_RUN = ["run", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions"];

interface Proc {
  child: ChildProcess;
  out(): string;
  err(): string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function envFor(scenario?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "substrate-observe-home-")) };
  if (scenario !== undefined) env.FAKE_SCENARIO_FILE = scenario;
  else delete env.FAKE_SCENARIO_FILE;
  return env;
}

function scenarioFile(calls: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-observe-scen-"));
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ calls }), "utf8");
  return file;
}

/** A solo run whose worker edits snake.txt and succeeds. */
function okSolo(): string {
  return scenarioFile([{ edits: { "snake.txt": "snake\n" }, reply: "DONE" }]);
}

/** A solo run whose worker waits on the gate session GATE, then edits snake.txt. */
function heldSolo(dir: string): string {
  return scenarioFile([
    {
      trace: { dir, name: "H", wait_for: ["GATE"], timeout_ms: 120000 },
      edits: { "snake.txt": "snake\n" },
      reply: "DONE",
    },
  ]);
}

function makeRepo(files: Record<string, string>, workers = 1): E2ERepo {
  const repo = createE2ERepo(files);
  mkdirSync(join(repo.dir, ".substrate"), { recursive: true });
  writeFileSync(
    join(repo.dir, ".substrate", "settings.json"),
    JSON.stringify({
      backends: {
        claude: { bin: join(binDir, "claude") },
        opencode: { bin: join(binDir, "opencode") },
        agy: { bin: join(binDir, "agy") },
      },
      concurrency: { workers },
    }),
    "utf8",
  );
  return repo;
}

function cli(repo: E2ERepo, args: string[], scenario?: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [substrateMjs, ...args], {
    cwd: repo.dir,
    encoding: "utf8",
    timeout: 120000,
    env: envFor(scenario),
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function startCli(repo: E2ERepo, args: string[], scenario?: string): Proc {
  const child = spawn(process.execPath, [substrateMjs, ...args], {
    cwd: repo.dir,
    env: envFor(scenario),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (err += d));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, out: () => out, err: () => err, exit };
}

/** Polls a condition until it holds; fails with the label after the timeout. */
async function until(condition: () => boolean, label: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
}

function runIdIn(text: string): string | undefined {
  return /run (r_[A-Z0-9]+) (?:started|resumed)/.exec(text)?.[1];
}

function runIdsOf(repo: E2ERepo): string[] {
  const dir = join(repo.dir, ".substrate", "runs");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("r_")).sort() : [];
}

function runDirOf(repo: E2ERepo, id: string): string {
  return join(repo.dir, ".substrate", "runs", id);
}

/** Removes the run-specific timestamps, run and session ids, so two runs' text can be compared. */
function normalize(text: string): string {
  return text
    .replace(/\[\d\d:\d\d\] /g, "[t] ")
    .replace(/r_[A-Z0-9]+/g, "RUN")
    .replace(/sess_[0-9a-f-]+/g, "SESS")
    .replace(/substrate\/runs\/RUN/g, "substrate/runs/RUN");
}

/** Every file and directory under `.substrate` with its size and mtime, for before-and-after comparison. */
function substrateSnapshot(repo: E2ERepo): Map<string, string> {
  const root = join(repo.dir, ".substrate");
  const snap = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      snap.set(relative(repo.dir, full), `${st.isDirectory() ? "d" : "f"} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
  return snap;
}

function traced(task: string, dir: string, opts: { edit: string; waitFor?: string[]; timeout?: number }): Record<string, unknown> {
  return {
    task,
    edits: { [opts.edit]: `seed ${task}\n${task.toLowerCase()}-done\n` },
    trace: { dir, name: task, ...(opts.waitFor ? { wait_for: opts.waitFor, timeout_ms: opts.timeout ?? 120000 } : {}) },
    reply: `${task} done\nDONE`,
  };
}

function planScenario(ids: string[], workerCalls: unknown[]): string {
  const specs: Record<string, string> = {};
  for (const id of ids) {
    specs[`tasks/${id}.md`] = taskSpec({
      id,
      write: [`src/${id.toLowerCase()}.txt`],
      verify: `grep -q ${id.toLowerCase()}-done src/${id.toLowerCase()}.txt`,
    });
  }
  return scenarioFile([planCall(contractFiles(manifestFor("Observe", ids), specs)), ...workerCalls]);
}

describe("R10.2: a run's progress is visible from another process", () => {
  it("(a) progress.log holds every progress line: text stdout equals the log body, and json and stream-json runs write one too", () => {
    const text = makeRepo({});
    const textRun = cli(text, [...SOLO_RUN, "make a snake game"], okSolo());
    try {
      expect(textRun.status, textRun.stderr).toBe(0);
      const id = runIdIn(textRun.stdout) as string;
      const logLines = readFileSync(join(runDirOf(text, id), "progress.log"), "utf8").split("\n");
      logLines.pop(); // the newline after the last line
      const header = logLines[0];
      const body = logLines.slice(1).join("\n") + "\n";
      expect(header).toMatch(new RegExp(`^# run ${id} started \\d{4}-\\d\\d-\\d\\dT`));
      // Text stdout is the progress lines and the summary block, the same text the log holds.
      expect(body).toBe(textRun.stdout);
      // The announcement follows the start line (R10.2).
      const lines = textRun.stdout.split("\n");
      expect(lines[1]).toMatch(new RegExp(`^\\[\\d\\d:\\d\\d\\] follow this run from another terminal: substrate watch ${id}$`));
      expect(lines[2]).toMatch(new RegExp(`^\\[\\d\\d:\\d\\d\\] log: \\.substrate/runs/${id}/progress\\.log$`));

      const jsonRepo = makeRepo({});
      const jsonRun = cli(jsonRepo, [...SOLO_RUN, "--output-format", "json", "make a snake game"], okSolo());
      expect(jsonRun.status, jsonRun.stderr).toBe(0);
      // json keeps its stdout contract: one object, nothing else.
      expect(jsonRun.stdout.trim().split("\n")).toHaveLength(1);
      const jsonId = JSON.parse(jsonRun.stdout.trim()).run_id as string;
      expect(jsonRun.stderr).toContain(`run ${jsonId} started; follow it with: substrate watch ${jsonId}\n`);
      const jsonLog = readFileSync(join(runDirOf(jsonRepo, jsonId), "progress.log"), "utf8");
      expect(normalize(jsonLog.split("\n").slice(1).join("\n"))).toBe(normalize(body));

      const streamRepo = makeRepo({});
      const streamRun = cli(streamRepo, [...SOLO_RUN, "--output-format", "stream-json", "make a snake game"], okSolo());
      expect(streamRun.status, streamRun.stderr).toBe(0);
      const streamId = runIdIn(streamRun.stderr) as string;
      expect(streamRun.stderr).toContain(`run ${streamId} started; follow it with: substrate watch ${streamId}`);
      for (const line of streamRun.stdout.trim().split("\n")) JSON.parse(line);
      const streamLog = readFileSync(join(runDirOf(streamRepo, streamId), "progress.log"), "utf8");
      expect(streamLog.startsWith(`# run ${streamId} started `)).toBe(true);
      expect(streamLog).toContain("--- Run Summary ---");
    } finally {
      text.cleanup();
    }
  }, 180000);

  it("(b) watch on a held run prints the lines so far, then lines that appear later, then the summary, and exits with the run's code", async () => {
    const repo = makeRepo({ "snake.txt": "" });
    const dir = mkdtempSync(join(tmpdir(), "substrate-observe-trace-"));
    const run = startCli(repo, [...SOLO_RUN, "make a snake game"], heldSolo(dir));
    try {
      await until(() => runIdIn(run.out()) !== undefined, "the run's start line");
      const id = runIdIn(run.out()) as string;
      await until(() => existsSync(join(dir, "start-H.json")), "the worker to start and hold");
      const watch = startCli(repo, ["watch", id]);
      await until(() => watch.out().includes("[task SOLO] started"), "watch to print the history");
      const snapshot = watch.out();
      expect(snapshot.startsWith(`# run ${id} started `)).toBe(true);
      expect(snapshot).not.toContain("worker finished");

      // Release the worker: the run goes on, and watch must show what happens after its snapshot.
      writeFileSync(join(dir, "start-GATE.json"), "{}", "utf8");
      const runExit = await run.exit;
      const watchExit = await watch.exit;
      expect(runExit.code, run.err()).toBe(0);
      expect(watchExit.code, watch.err()).toBe(runExit.code);
      expect(watch.out().startsWith(snapshot)).toBe(true);
      expect(watch.out().slice(snapshot.length)).toContain("worker finished");
      expect(watch.out()).toContain("--- Run Summary ---");
      expect(watch.out()).toContain("Status:     finished");
      // The lines watch printed are the lines the run printed, bar the timestamps' rounding and the header.
      const watchBody = watch.out().split("\n").slice(1).join("\n");
      expect(normalize(watchBody)).toBe(normalize(run.out()));
    } finally {
      if (run.child.exitCode === null) run.child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 180000);

  it("(c) watch on a finished run replays it and exits with its code; a failed run exits 1; --no-follow returns at once; an unknown id is exit 2", () => {
    const repo = makeRepo({});
    try {
      const ok = cli(repo, [...SOLO_RUN, "make a snake game"], okSolo());
      expect(ok.status, ok.stderr).toBe(0);
      const okId = runIdIn(ok.stdout) as string;
      const failed = cli(repo, [...SOLO_RUN, "make a broken game"]);
      expect(failed.status).toBe(1);
      const failedId = runIdIn(failed.stdout) as string;

      const replay = cli(repo, ["watch", okId]);
      expect(replay.status, replay.stderr).toBe(0);
      expect(replay.stdout).toContain("[task SOLO] started");
      expect(replay.stdout).toContain("Status:     finished");

      const failedReplay = cli(repo, ["watch", failedId]);
      expect(failedReplay.status, failedReplay.stderr).toBe(1);
      expect(failedReplay.stdout).toContain("Status:     failed");

      const started = Date.now();
      const noFollow = cli(repo, ["watch", failedId, "--no-follow"]);
      const elapsed = Date.now() - started;
      expect(noFollow.status).toBe(0);
      expect(noFollow.stdout).toContain("[task SOLO] started");
      expect(noFollow.stdout).not.toContain("--- Run Summary ---");
      expect(elapsed).toBeLessThan(30000);

      const unknown = cli(repo, ["watch", "r_NOSUCHRUN"]);
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toContain("No such run: r_NOSUCHRUN");
    } finally {
      repo.cleanup();
    }
  }, 180000);

  it("(d) after SIGKILL: watch names the resume command and exits 1, status and runs say stopped, and resume picks it up with a # resumed line", async () => {
    const repo = makeRepo({ "snake.txt": "" });
    const dir = mkdtempSync(join(tmpdir(), "substrate-observe-kill-"));
    const run = startCli(repo, [...SOLO_RUN, "make a snake game"], heldSolo(dir));
    try {
      await until(() => runIdIn(run.out()) !== undefined, "the run's start line");
      const id = runIdIn(run.out()) as string;
      await until(() => existsSync(join(dir, "start-H.json")), "the worker to hold");
      process.kill(run.child.pid as number, "SIGKILL");
      await run.exit;

      const watch = cli(repo, ["watch", id]);
      expect(watch.status).toBe(1);
      expect(watch.stderr).toContain(
        `run ${id} is not running (the process that started it has gone). Resume with: substrate resume ${id}`,
      );

      const status = cli(repo, ["status", id]);
      expect(status.stdout).toContain(`Process: not running (stopped; resume with: substrate resume ${id})`);
      expect(status.stdout).toMatch(new RegExp(`Run ${id}  stopped`));

      const statusJson = JSON.parse(cli(repo, ["status", id, "--output-format", "json"]).stdout);
      expect(statusJson.status).toBe("stopped");
      expect(statusJson.process).toMatchObject({ pid: run.child.pid, alive: false });

      const runs = cli(repo, ["runs"]);
      expect(runs.stdout.split("\n").find((l) => l.startsWith(id))).toMatch(/ stopped /);

      // Resume: the worker the killed CLI left behind is ended, the task runs again, and the run finishes.
      const resumed = cli(repo, ["resume", id], okSolo());
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      // Text mode: the resume names itself on stdout, with the two follow lines.
      expect(resumed.stdout).toContain(`run ${id} resumed\n`);
      expect(resumed.stdout).toContain(`follow this run from another terminal: substrate watch ${id}\n`);
      const history = cli(repo, ["watch", id, "--no-follow"]);
      expect(history.stdout).toMatch(/^# run r_\w+ started /m);
      expect(history.stdout).toMatch(/^# resumed \d{4}-\d\d-\d\dT/m);
      expect(readFileSync(join(runDirOf(repo, id), "progress.log"), "utf8")).toMatch(/^# resumed /m);
    } finally {
      if (run.child.exitCode === null) run.child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 180000);

  it("(e) status while two workers run: phase, counts, process and pid; after the run: finished and merged, in text and json", async () => {
    const repo = makeRepo(PLAN_SEED, 2);
    const dir = mkdtempSync(join(tmpdir(), "substrate-observe-plan-"));
    const scenario = planScenario(["T1", "T3"], [
      traced("T1", dir, { edit: "src/t1.txt", waitFor: ["GATE"] }),
      traced("T3", dir, { edit: "src/t3.txt", waitFor: ["GATE"] }),
    ]);
    const run = startCli(repo, [...PLAN_RUN, "Observe two workers"], scenario);
    try {
      await until(() => runIdIn(run.out()) !== undefined, "the run's start line");
      const id = runIdIn(run.out()) as string;
      await until(() => existsSync(join(dir, "start-T1.json")) && existsSync(join(dir, "start-T3.json")), "both workers to hold");

      const json = JSON.parse(cli(repo, ["status", id, "--output-format", "json"]).stdout);
      expect(json.phase).toBe("running T1, T3");
      expect(json.status).toBe("running");
      expect(json.process).toMatchObject({ pid: run.child.pid, alive: true });
      expect(json.counts).toMatchObject({ passed: 0, running: 2, failed: 0, waiting: 0 });
      expect(typeof json.elapsed_s).toBe("number");
      expect(typeof json.last_event_ts).toBe("string");
      expect(typeof json.cost_usd).toBe("number");
      expect(json.budget_usd === null || typeof json.budget_usd === "number").toBe(true);
      expect(json.request).toBe("Observe two workers");
      expect(json.planner).toMatch(/^claude:/);
      expect(json.worker).toMatch(/^claude:/);
      expect(json.log).toBe(`.substrate/runs/${id}/progress.log`);
      expect(json.next).toEqual([`substrate watch ${id}`]);
      expect(json.task_list.map((t: { id: string; state: string }) => [t.id, t.state])).toEqual([
        ["T1", "running"],
        ["T3", "running"],
      ]);
      expect(json.task_list[0]).toMatchObject({ generation: 1, attempt: 1, merged: false });
      expect(json.task_list[0].started_at).toEqual(expect.any(String));

      const text = cli(repo, ["status", id]).stdout;
      expect(text).toContain("Phase:  running T1, T3");
      expect(text).toContain(`Process: pid ${run.child.pid} alive`);
      expect(text).toContain("Tasks: 0 passed, 2 running, 0 failed, 0 waiting");
      expect(text).toMatch(/^ {2}T1 /m);
      expect(text).toMatch(/^ {2}T3 /m);
      expect(text).toContain("=== Run Status ===");

      writeFileSync(join(dir, "start-GATE.json"), "{}", "utf8");
      const runExit = await run.exit;
      expect(runExit.code, run.err()).toBe(0);
      expect(run.out()).toContain("Merged:     yes");

      const done = JSON.parse(cli(repo, ["status", id, "--output-format", "json"]).stdout);
      expect(done.status).toBe("finished");
      expect(done.process).toBeNull();
      expect(done.counts).toMatchObject({ passed: 2, running: 0 });
      expect(done.task_list.every((t: { merged: boolean }) => t.merged)).toBe(true);
      expect(done.next).toEqual([]);
      expect(done.summary).toBe(`.substrate/runs/${id}/summary.txt`);
      expect(done.result).toBe(`.substrate/runs/${id}/result.json`);
      const doneText = cli(repo, ["status", id]).stdout;
      expect(doneText).toContain("Outcome: summary.txt, result.json");
    } finally {
      if (run.child.exitCode === null) run.child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 180000);

  it("(f) runs lists three runs with their states, newest first; an empty project says No runs yet", async () => {
    const empty = makeRepo({});
    try {
      const none = cli(empty, ["runs"]);
      expect(none.status).toBe(0);
      expect(none.stdout).toBe("No runs yet\n");
    } finally {
      empty.cleanup();
    }

    const repo = makeRepo({ "snake.txt": "" });
    const dir = mkdtempSync(join(tmpdir(), "substrate-observe-int-"));
    try {
      const finished = cli(repo, [...SOLO_RUN, "make a snake game"], okSolo());
      const finishedId = runIdIn(finished.stdout) as string;
      const failed = cli(repo, [...SOLO_RUN, "make a broken game"]);
      const failedId = runIdIn(failed.stdout) as string;
      const held = startCli(repo, [...SOLO_RUN, "make an interrupted game"], heldSolo(dir));
      await until(() => runIdIn(held.out()) !== undefined, "the interrupted run's start line");
      const interruptedId = runIdIn(held.out()) as string;
      await until(() => existsSync(join(dir, "start-H.json")), "the worker to hold");
      held.child.kill("SIGINT");
      await held.exit;

      const listing = cli(repo, ["runs"]);
      expect(listing.status).toBe(0);
      const rows = listing.stdout.trim().split("\n");
      expect(rows).toHaveLength(3);
      // Newest first: the interrupted run started last.
      expect(rows[0].startsWith(interruptedId)).toBe(true);
      expect(rows[0]).toMatch(/ interrupted /);
      expect(rows[1].startsWith(failedId)).toBe(true);
      expect(rows[1]).toMatch(/ failed /);
      expect(rows[2].startsWith(finishedId)).toBe(true);
      expect(rows[2]).toMatch(/ finished /);
      expect(rows[2]).toMatch(/1\/1 passed {2}merged yes {2}make a snake game$/);

      const json = JSON.parse(cli(repo, ["runs", "--output-format", "json"]).stdout);
      expect(json.map((r: { run_id: string; status: string }) => [r.run_id, r.status])).toEqual([
        [interruptedId, "interrupted"],
        [failedId, "failed"],
        [finishedId, "finished"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 240000);

  it("(g) a finished, a failed, an interrupted and an internal-error run each keep summary.txt and result.json matching their stdout", async () => {
    const repo = makeRepo({ "snake.txt": "" });
    const dir = mkdtempSync(join(tmpdir(), "substrate-observe-outcome-"));
    try {
      // finished, in json mode: result.json is the object the run printed.
      const finished = cli(repo, [...SOLO_RUN, "--output-format", "json", "make a snake game"], okSolo());
      expect(finished.status, finished.stderr).toBe(0);
      const finishedJson = JSON.parse(finished.stdout.trim());
      const finishedDir = runDirOf(repo, finishedJson.run_id);
      expect(JSON.parse(readFileSync(join(finishedDir, "result.json"), "utf8"))).toEqual(finishedJson);
      expect(existsSync(join(finishedDir, "summary.txt"))).toBe(true);

      // finished, in text mode: summary.txt is the summary block on stdout.
      const text = cli(repo, [...SOLO_RUN, "make a second snake"], okSolo());
      const textId = runIdIn(text.stdout) as string;
      const summary = readFileSync(join(runDirOf(repo, textId), "summary.txt"), "utf8");
      expect(text.stdout.endsWith(summary)).toBe(true);
      expect(summary).toContain("--- Run Summary ---");
      expect(summary).toContain("Status:     finished");

      // failed: the worker crashes (no scenario).
      const failed = cli(repo, [...SOLO_RUN, "--output-format", "json", "make a broken game"]);
      expect(failed.status).toBe(1);
      const failedJson = JSON.parse(failed.stdout.trim());
      const failedResult = JSON.parse(readFileSync(join(runDirOf(repo, failedJson.run_id), "result.json"), "utf8"));
      expect(failedResult).toEqual(failedJson);
      expect(failedResult.status).toBe("failed");
      expect(readFileSync(join(runDirOf(repo, failedJson.run_id), "summary.txt"), "utf8")).toContain("Status:     failed");

      // interrupted: SIGINT while the worker holds.
      const held = startCli(repo, [...SOLO_RUN, "make an interrupted game"], heldSolo(dir));
      await until(() => runIdIn(held.out()) !== undefined, "the interrupted run's start line");
      const interruptedId = runIdIn(held.out()) as string;
      await until(() => existsSync(join(dir, "start-H.json")), "the worker to hold");
      held.child.kill("SIGINT");
      const heldExit = await held.exit;
      expect(heldExit.code).toBe(130);
      const interruptedResult = JSON.parse(readFileSync(join(runDirOf(repo, interruptedId), "result.json"), "utf8"));
      expect(interruptedResult).toMatchObject({ status: "paused", pause_reason: "user_cancel", exit_code: 130 });
      expect(readFileSync(join(runDirOf(repo, interruptedId), "summary.txt"), "utf8")).toContain(
        `Interrupted. Resume with: substrate resume ${interruptedId}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 240000);

  it("(g) an internal-error run ends failed, and its summary.txt and result.json name the internal error", () => {
    const repo = makeRepo(PLAN_SEED);
    const broken = "Work on {{spec_path}} and {{unknown_variable}}.\n";
    mkdirSync(join(repo.dir, ".substrate", "prompts", "worker"), { recursive: true });
    writeFileSync(join(repo.dir, ".substrate", "prompts", "worker", "task.md"), broken, "utf8");
    try {
      const specs = { "tasks/T1.md": taskSpec({ id: "T1", title: "Create the file", write: [], create: ["src/t1.txt"], verify: "test -f src/t1.txt" }) };
      const scenario = scenarioFile([planCall(contractFiles(manifestFor("Internal error", ["T1"], "echo verify all"), specs))]);
      const res = cli(repo, [...PLAN_RUN, "Build the internal error case"], scenario);
      expect(res.status).toBe(1);
      const id = runIdIn(res.stdout) as string;
      const result = JSON.parse(readFileSync(join(runDirOf(repo, id), "result.json"), "utf8"));
      expect(result).toMatchObject({ status: "failed", failure_class: "internal_error", exit_code: 1 });
      const summary = readFileSync(join(runDirOf(repo, id), "summary.txt"), "utf8");
      expect(summary).toContain("Reason:     internal error: missing template variable: unknown_variable");
      expect(res.stdout.endsWith(summary)).toBe(true);
    } finally {
      repo.cleanup();
    }
  }, 180000);

  it("(h) watch and status change nothing under .substrate, and a live watch takes no lock", async () => {
    const repo = makeRepo({ "snake.txt": "" });
    const dir = mkdtempSync(join(tmpdir(), "substrate-observe-readonly-"));
    try {
      const finished = cli(repo, [...SOLO_RUN, "make a snake game"], okSolo());
      const id = runIdIn(finished.stdout) as string;
      const before = substrateSnapshot(repo);
      cli(repo, ["status", id]);
      cli(repo, ["status", id, "--output-format", "json"]);
      cli(repo, ["runs"]);
      cli(repo, ["runs", "--output-format", "json"]);
      cli(repo, ["watch", id, "--no-follow"]);
      cli(repo, ["watch", id]);
      expect(substrateSnapshot(repo)).toEqual(before);

      // A live watch on a held run: the lock file is the run's, and it is not rewritten by the watch.
      const held = startCli(repo, [...SOLO_RUN, "make a second game"], heldSolo(dir));
      try {
        await until(() => runIdIn(held.out()) !== undefined, "the run's start line");
        const liveId = runIdIn(held.out()) as string;
        await until(() => existsSync(join(dir, "start-H.json")), "the worker to hold");
        const lockPath = join(repo.dir, ".substrate", "state", `${liveId}.lock`);
        const lockBefore = readFileSync(lockPath, "utf8");
        expect(JSON.parse(lockBefore).pid).toBe(held.child.pid);
        const watch = startCli(repo, ["watch", liveId]);
        await until(() => watch.out().includes("[task SOLO] started"), "watch to print the history");
        const midSnapshot = substrateSnapshot(repo);
        expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
        expect(midSnapshot.get(relative(repo.dir, lockPath))).toBeDefined();
        writeFileSync(join(dir, "start-GATE.json"), "{}", "utf8");
        expect((await held.exit).code).toBe(0);
        expect((await watch.exit).code).toBe(0);
      } finally {
        if (held.child.exitCode === null) held.child.kill("SIGKILL");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 240000);

  it("(i) a progress.log that cannot be written does not fail the run: one warning, and the run still finishes", async () => {
    const repo = makeRepo({ "snake.txt": "" });
    const dir = mkdtempSync(join(tmpdir(), "substrate-observe-write-"));
    const run = startCli(repo, [...SOLO_RUN, "make a snake game"], heldSolo(dir));
    try {
      await until(() => runIdIn(run.out()) !== undefined, "the run's start line");
      const id = runIdIn(run.out()) as string;
      await until(() => existsSync(join(dir, "start-H.json")), "the worker to hold");
      process.kill(run.child.pid as number, "SIGKILL");
      await run.exit;

      // Make the log path a directory: every append now fails.
      const log = join(runDirOf(repo, id), "progress.log");
      rmSync(log, { force: true });
      mkdirSync(log);
      const resumed = cli(repo, ["resume", id], okSolo());
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain("--- Run Summary ---");
      expect(resumed.stdout).toContain("Status:     finished");
      expect(resumed.stderr.split("progress log").length - 1).toBe(1);
      expect(resumed.stderr).toContain("is not written");
    } finally {
      if (run.child.exitCode === null) run.child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 180000);
});
