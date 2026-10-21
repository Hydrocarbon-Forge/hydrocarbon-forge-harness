import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R10.3: control of a run from outside its process. These tests drive the built CLI
// (dist/substrate.mjs) with the fake harness. A worker is held by a trace barrier named GATE: it
// waits until a file start-GATE.json appears in its trace directory, or until its timeout. The test
// spawns every long-lived process, and kills by recorded numeric pid in afterEach.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };
const MODELS = ["--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True while the pid names a process that has not exited (a zombie has exited). */
function alive(pid: number): boolean {
  const res = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  const stat = (res.stdout ?? "").trim();
  return res.status === 0 && stat.length > 0 && !stat.startsWith("Z");
}

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

/** Every process and directory this test made, cleaned up in afterEach. */
const pids: number[] = [];
const children: ChildProcess[] = [];
const repos: E2ERepo[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function newRepo(): E2ERepo {
  const repo = createE2ERepo(SEED);
  repos.push(repo);
  mkdirSync(join(repo.dir, ".substrate"), { recursive: true });
  writeFileSync(
    join(repo.dir, ".substrate", "settings.json"),
    JSON.stringify({
      backends: { claude: { bin: join(binDir, "claude") }, opencode: { bin: join(binDir, "opencode") }, agy: { bin: join(binDir, "agy") } },
      concurrency: { workers: 1 },
    }),
    "utf8",
  );
  return repo;
}

/** The fake scenario for one run: its own file, and its own HOME so nothing is shared. */
function scenarioFor(calls: unknown[]): { env: NodeJS.ProcessEnv; scenarioPath: string } {
  const dir = tempDir("substrate-control-scn-");
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ calls }), "utf8");
  const home = tempDir("substrate-control-home-");
  return { env: { ...process.env, HOME: home, FAKE_SCENARIO_FILE: scenarioPath }, scenarioPath };
}

function tasksOf(ids: string[]): Record<string, string> {
  const specs: Record<string, string> = {};
  for (const id of ids) {
    const lower = id.toLowerCase();
    specs[`tasks/${id}.md`] = taskSpec({ id, write: [`src/${lower === "t1" ? "a" : "b"}.txt`], verify: `grep -q ${lower}-done src/${lower === "t1" ? "a" : "b"}.txt` });
  }
  return specs;
}

function planFor(goal: string, ids: string[]): Record<string, unknown> {
  return planCall(contractFiles(manifestFor(goal, ids), tasksOf(ids)));
}

/** A worker that passes at once: T1 writes src/a.txt, T2 writes src/b.txt. */
function okWorker(task: "T1" | "T2"): Record<string, unknown> {
  const file = task === "T1" ? "src/a.txt" : "src/b.txt";
  const seed = task === "T1" ? "seed a" : "seed b";
  return { edits: { [file]: `${seed}\n${task.toLowerCase()}-done\n` }, reply: `${task} done\nDONE` };
}

/** A worker held at its barrier GATE until the test writes start-GATE.json in dir (or the timeout). */
function heldWorker(task: "T1" | "T2", dir: string): Record<string, unknown> {
  const file = task === "T1" ? "src/a.txt" : "src/b.txt";
  const seed = task === "T1" ? "seed a" : "seed b";
  return {
    edits: { [file]: `${seed}\n${task.toLowerCase()}-done\n` },
    trace: { dir, name: task, wait_for: ["GATE"], timeout_ms: 120000 },
    reply: `${task} done\nDONE`,
  };
}

interface Launched {
  child: ChildProcess;
  exited: Promise<number | null>;
  stdout(): string;
  stderr(): string;
}

function launch(repo: E2ERepo, args: string[], env: NodeJS.ProcessEnv): Launched {
  const child = spawn(process.execPath, [substrateMjs, ...args], { cwd: repo.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on("data", (d) => out.push(d.toString()));
  child.stderr?.on("data", (d) => err.push(d.toString()));
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  return { child, exited, stdout: () => out.join(""), stderr: () => err.join("") };
}

interface Done {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

async function run(repo: E2ERepo, args: string[], env: NodeJS.ProcessEnv): Promise<Done> {
  const started = Date.now();
  const l = launch(repo, args, env);
  const code = await Promise.race([l.exited, sleep(170000).then(() => "timeout" as const)]);
  return { code: code === "timeout" ? null : code, stdout: l.stdout(), stderr: l.stderr(), ms: Date.now() - started };
}

/** The run id whose lock names this pid, from .substrate/state/<run-id>.lock. */
function runIdOfPid(repo: E2ERepo, pid: number): string | undefined {
  const dir = join(repo.dir, ".substrate", "state");
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".lock"))) {
    try {
      const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (data.pid === pid) return data.run_id as string;
    } catch {
      // not yet written
    }
  }
  return undefined;
}

function eventsOf(repo: E2ERepo, runId: string): Array<{ type: string; data: any }> {
  return readFileSync(join(repo.dir, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function readStart(dir: string, name: string): { pid: number } | undefined {
  const file = join(dir, `start-${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** Waits until the held worker of the named task has started; returns its pid (recorded for cleanup). */
async function heldPid(dir: string, name: string): Promise<number> {
  const ok = await waitUntil(() => readStart(dir, name) !== undefined, 60000);
  expect(ok, `${name} worker started`).toBe(true);
  const pid = readStart(dir, name)!.pid;
  pids.push(pid);
  return pid;
}

describe("R10.3: substrate stop ends a run from another terminal", () => {
  it("stop on a held run: SIGTERM, exit 0 within 15 s, the worker is gone, the run is paused by the user and resume finishes it without redoing T1", async () => {
    const repo = newRepo();
    const trace = tempDir("substrate-control-trace-");
    const scn = scenarioFor([planFor("Stop case", ["T1", "T2"]), okWorker("T1"), heldWorker("T2", trace), okWorker("T2")]);
    const runner = launch(repo, ["run", ...MODELS, "Stop case"], scn.env);
    const workerPid = await heldPid(trace, "T2");
    const runId = (await waitUntil(() => runIdOfPid(repo, runner.child.pid!) !== undefined, 10000)) ? runIdOfPid(repo, runner.child.pid!)! : "";
    expect(runId).not.toBe("");

    const stopped = await run(repo, ["stop", runId], scn.env);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.ms).toBeLessThan(15000);
    expect(stopped.stdout).toContain(`stopping run ${runId} (pid ${runner.child.pid})...`);
    expect(stopped.stdout).toContain(`run ${runId} stopped. Resume with: substrate resume ${runId}`);
    expect(await waitUntil(() => !alive(workerPid), 5000), "the held worker is gone").toBe(true);
    expect(await runner.exited).toBe(143);

    const paused = eventsOf(repo, runId).filter((e) => e.type === "run.paused").at(-1);
    expect(paused?.data.reason).toBe("user_cancel");

    const resumed = await run(repo, ["resume", runId, ...MODELS], scn.env);
    expect(resumed.code, resumed.stderr + resumed.stdout).toBe(0);
    const events = eventsOf(repo, runId);
    const started = events.filter((e) => e.type === "task.session.started" && e.data.task_id === "T1");
    expect(started.length, "T1 passed before the stop and is not run again").toBe(1);
    expect(events.some((e) => e.type === "run.finished" && e.data.exit_code === 0)).toBe(true);
  }, 240000);

  it("stop with no run id and two live runs in one project refuses with exit 2, lists both, and stop <id> stops only that one", async () => {
    const repo = newRepo();
    const traceA = tempDir("substrate-control-trace-");
    const traceB = tempDir("substrate-control-trace-");
    const a = scenarioFor([planFor("Case A", ["T1"]), heldWorker("T1", traceA)]);
    const b = scenarioFor([planFor("Case B", ["T1"]), heldWorker("T1", traceB)]);
    const runA = launch(repo, ["run", ...MODELS, "Case A"], a.env);
    const runB = launch(repo, ["run", ...MODELS, "Case B"], b.env);
    await heldPid(traceA, "T1");
    await heldPid(traceB, "T1");
    const idA = (await waitUntil(() => runIdOfPid(repo, runA.child.pid!) !== undefined, 10000)) ? runIdOfPid(repo, runA.child.pid!)! : "";
    const idB = (await waitUntil(() => runIdOfPid(repo, runB.child.pid!) !== undefined, 10000)) ? runIdOfPid(repo, runB.child.pid!)! : "";
    expect(idA).not.toBe("");
    expect(idB).not.toBe("");

    const refused = await run(repo, ["stop"], a.env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(idA);
    expect(refused.stderr).toContain(idB);

    const one = await run(repo, ["stop", idA], a.env);
    expect(one.code, one.stderr).toBe(0);
    expect(await runA.exited).toBe(143);
    expect(alive(runB.child.pid!), "the other run keeps going").toBe(true);

    const two = await run(repo, ["stop", idB], b.env);
    expect(two.code, two.stderr).toBe(0);
    expect(await runB.exited).toBe(143);
  }, 240000);

  it("stop on a run that ended says so, exit 0; stop with no run running says so, exit 0", async () => {
    const repo = newRepo();
    const scn = scenarioFor([planFor("Done case", ["T1"]), okWorker("T1")]);
    const done = await run(repo, ["run", ...MODELS, "Done case"], scn.env);
    expect(done.code, done.stderr).toBe(0);
    const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1)!;

    const ended = await run(repo, ["stop", runId], scn.env);
    expect(ended.code).toBe(0);
    expect(ended.stdout).toContain(`run ${runId} is not running (it ended finished)`);

    const none = await run(repo, ["stop"], scn.env);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("no run is running in this project");
  }, 120000);

  it("a run whose process was SIGKILLed is not running (stopped): stop says so and names the resume", async () => {
    const repo = newRepo();
    const trace = tempDir("substrate-control-trace-");
    const scn = scenarioFor([planFor("Kill case", ["T1"]), heldWorker("T1", trace)]);
    const runner = launch(repo, ["run", ...MODELS, "Kill case"], scn.env);
    const workerPid = await heldPid(trace, "T1");
    const runId = (await waitUntil(() => runIdOfPid(repo, runner.child.pid!) !== undefined, 10000)) ? runIdOfPid(repo, runner.child.pid!)! : "";
    expect(runId).not.toBe("");
    runner.child.kill("SIGKILL");
    await runner.exited;

    const stopped = await run(repo, ["stop", runId], scn.env);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain(`run ${runId} is not running (stopped). Resume with: substrate resume ${runId}`);
    // The worker outlived its CLI; the test ends it by its recorded pid.
    expect(alive(workerPid)).toBe(true);
  }, 120000);

  it("a lock naming a process that is not Substrate is refused: stop exits 1 and does not signal it", async () => {
    const repo = newRepo();
    const scn = scenarioFor([planFor("Stale case", ["T1"]), okWorker("T1")]);
    const done = await run(repo, ["run", ...MODELS, "Stale case"], scn.env);
    expect(done.code, done.stderr).toBe(0);
    const runId = readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1)!;

    const sleeper = spawn("sleep", ["100"], { stdio: "ignore" });
    children.push(sleeper);
    const sleeperPid = sleeper.pid!;
    pids.push(sleeperPid);
    mkdirSync(join(repo.dir, ".substrate", "state"), { recursive: true });
    writeFileSync(
      join(repo.dir, ".substrate", "state", `${runId}.lock`),
      JSON.stringify({ pid: sleeperPid, run_id: runId, acquired_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() }),
      "utf8",
    );

    const refused = await run(repo, ["stop", runId], scn.env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`pid ${sleeperPid} is not a Substrate process (stale lock); not signalling it`);
    await sleep(300);
    expect(alive(sleeperPid), "the sleeper was not signalled").toBe(true);
  }, 120000);
});
