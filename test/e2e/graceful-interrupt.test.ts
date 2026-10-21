import { describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R8.2 graceful: an interrupted run stops promptly, kills its workers, says how to resume,
// and a resume finishes it without redoing the tasks that passed. A hard kill (SIGKILL) leaves
// a worker behind; the next resume finds its recorded pid and ends it.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== "ESRCH";
  }
}

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function git(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

function eventsOf(repo: E2ERepo): Array<{ type: string; data: any }> {
  const runsBase = join(repo.dir, ".substrate", "runs");
  const runId = readdirSync(runsBase).sort().at(-1) as string;
  return readFileSync(join(runsBase, runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function runIdOf(repo: E2ERepo): string {
  return readdirSync(join(repo.dir, ".substrate", "runs")).sort().at(-1) as string;
}

// Two tasks: T1 passes at once, T2's worker hangs (call 2) until the run is interrupted. The
// resume's worker for T2 is call 3, appended to the scenario before the resume.
function twoTasks() {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  return {
    manifest: manifestFor("Interrupt", ["T1", "T2"]),
    specs: { "tasks/T1.md": t1, "tasks/T2.md": t2 },
  };
}

const RUN_ARGS = ["--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions"];

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

describe("R8.2 graceful: interrupt, resume and hard kill", () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  it(`${signal} stops a run with a hanging worker: exit ${code} within 5 s, the worker is gone, the run resumes`, async () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r82-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const plan = twoTasks();
    const planC = planCall(contractFiles(plan.manifest, plan.specs));
    const { env, homeDir } = setup(repo, scenarioPath, [
      planC,
      { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
      { failure: "hang" },
    ]);
    const headBefore = git(repo.dir, ["rev-parse", "HEAD"]);
    let child: ChildProcess | undefined;
    let workerPid: number | undefined;
    try {
      const stderr: string[] = [];
      const stdout: string[] = [];
      child = spawn(process.execPath, [substrateMjs, "run", ...RUN_ARGS, "Interrupt case"], { cwd: repo.dir, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (d) => stdout.push(d.toString()));
      child.stderr?.on("data", (d) => stderr.push(d.toString()));
      const exited = new Promise<number | null>((res) => child!.on("exit", (code) => res(code)));

      expect(await waitUntil(() => existsSync(`${scenarioPath}.pid`), 30000)).toBe(true);
      workerPid = parseInt(readFileSync(`${scenarioPath}.pid`, "utf8").trim(), 10);
      expect(pidAlive(workerPid)).toBe(true);

      const sentAt = Date.now();
      child.kill(signal);
      const exitCode = await Promise.race([exited, sleep(10000).then(() => "timeout" as const)]);
      expect(Date.now() - sentAt).toBeLessThan(5000);
      expect(exitCode).toBe(code);

      expect(await waitUntil(() => !pidAlive(workerPid!), 3000), "the hung worker is gone").toBe(true);
      const runId = runIdOf(repo);
      const out = stdout.join("") + stderr.join("");
      expect(out).toContain(`Interrupted. Resume with: substrate resume ${runId}`);
      expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
      const paused = eventsOf(repo).filter((e) => e.type === "run.paused").at(-1);
      expect(paused?.data.reason).toBe("user_cancel");

      // Resume: the hung call is spent, the next call is T2's worker. T1 is not run again.
      writeFileSync(scenarioPath, JSON.stringify({ calls: [planC, { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" }, { failure: "hang" }, { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" }] }), "utf8");
      const resumed = spawnSync(process.execPath, [substrateMjs, "resume", runId], { cwd: repo.dir, env, encoding: "utf8", timeout: 120000 });
      expect(resumed.status, `${resumed.stdout.slice(-800)}\n${resumed.stderr.slice(-400)}`).toBe(0);
      const starts = eventsOf(repo).filter((e) => e.type === "task.session.started").map((e) => e.data.task_id);
      expect(starts.filter((id) => id === "T1")).toHaveLength(1);
      expect(starts.filter((id) => id === "T2").length).toBeGreaterThanOrEqual(2);
      expect(eventsOf(repo).filter((e) => e.type === "run.finished").at(-1)?.data.exit_code).toBe(0);
      expect(git(repo.dir, ["show", `substrate/runs/${runId}:src/b.txt`])).toContain("t2-done");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (workerPid !== undefined && pidAlive(workerPid)) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {}
      }
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120000);
  }

  it("SIGKILL of the CLI leaves a worker; the next resume ends it and finishes the run", async () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r82-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const plan = twoTasks();
    const planC = planCall(contractFiles(plan.manifest, plan.specs));
    const { env, homeDir } = setup(repo, scenarioPath, [planC, { failure: "hang" }]);
    let child: ChildProcess | undefined;
    let workerPid: number | undefined;
    try {
      child = spawn(process.execPath, [substrateMjs, "run", ...RUN_ARGS, "Hard kill case"], { cwd: repo.dir, env, stdio: "ignore" });
      const exited = new Promise<void>((res) => child!.on("exit", () => res()));
      expect(await waitUntil(() => existsSync(`${scenarioPath}.pid`), 30000)).toBe(true);
      workerPid = parseInt(readFileSync(`${scenarioPath}.pid`, "utf8").trim(), 10);
      child.kill("SIGKILL");
      await exited;
      // The worker outlives the CLI (it is in its own process group); the run dir records it.
      expect(pidAlive(workerPid)).toBe(true);
      const runId = runIdOf(repo);
      const recorded = join(repo.dir, ".substrate", "runs", runId, "workers");
      expect(existsSync(recorded) && readdirSync(recorded).length > 0, "a worker pid is recorded in the run dir").toBe(true);

      writeFileSync(scenarioPath, JSON.stringify({ calls: [planC, { failure: "hang" }, { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" }, { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" }] }), "utf8");
      const resumed = spawnSync(process.execPath, [substrateMjs, "resume", runId], { cwd: repo.dir, env, encoding: "utf8", timeout: 120000 });
      expect(resumed.status, `${resumed.stdout.slice(-800)}\n${resumed.stderr.slice(-400)}`).toBe(0);
      expect(await waitUntil(() => !pidAlive(workerPid!), 3000), "the stale worker is ended by resume").toBe(true);
      expect(eventsOf(repo).filter((e) => e.type === "run.finished").at(-1)?.data.exit_code).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (workerPid !== undefined && pidAlive(workerPid)) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {}
      }
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120000);
});

// Starts a run whose second task hangs, interrupts it (SIGINT) once the worker is up, and returns
// the run id. The run is paused (user_cancel), so a resume continues it.
async function interruptedRun(repo: E2ERepo, env: NodeJS.ProcessEnv, scenarioPath: string, args: string[]): Promise<string> {
  const child = spawn(process.execPath, [substrateMjs, "run", ...args], { cwd: repo.dir, env, stdio: "ignore" });
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  let workerPid: number | undefined;
  try {
    expect(await waitUntil(() => existsSync(`${scenarioPath}.pid`), 30000)).toBe(true);
    workerPid = parseInt(readFileSync(`${scenarioPath}.pid`, "utf8").trim(), 10);
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(await waitUntil(() => !pidAlive(workerPid!), 3000)).toBe(true);
    return runIdOf(repo);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (workerPid !== undefined && pidAlive(workerPid)) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {}
    }
  }
}

describe("R8.2 graceful: resume keeps the models the run started with (known issue 18)", () => {
  it("a resumed run without --plan or --work uses the run's recorded models", async () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r82-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const plan = twoTasks();
    const planC = planCall(contractFiles(plan.manifest, plan.specs));
    const t1Edit = { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" };
    const { env, homeDir } = setup(repo, scenarioPath, [planC, t1Edit, { failure: "hang" }]);
    try {
      const runId = await interruptedRun(repo, env, scenarioPath, [...RUN_ARGS, "Models case"]);
      const created = eventsOf(repo).find((e) => e.type === "run.created");
      expect(created?.data.requested_roles?.worker?.model).toBe("haiku");
      expect(created?.data.requested_roles?.planner?.model).toBe("claude-sonnet-5-5");

      writeFileSync(scenarioPath, JSON.stringify({ calls: [planC, t1Edit, { failure: "hang" }, { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" }] }), "utf8");
      const resumed = spawnSync(process.execPath, [substrateMjs, "resume", runId], { cwd: repo.dir, env, encoding: "utf8", timeout: 120000 });
      expect(resumed.status, `${resumed.stdout.slice(-800)}\n${resumed.stderr.slice(-400)}`).toBe(0);
      const t2Starts = eventsOf(repo).filter((e) => e.type === "task.session.started" && e.data.task_id === "T2");
      expect(t2Starts.at(-1)?.data.model).toBe("haiku");
    } finally {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120000);

  it("a resume that names --work again uses the named model for the remaining tasks", async () => {
    const repo = createE2ERepo(SEED);
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-r82-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const plan = twoTasks();
    const planC = planCall(contractFiles(plan.manifest, plan.specs));
    const t1Edit = { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" };
    const { env, homeDir } = setup(repo, scenarioPath, [planC, t1Edit, { failure: "hang" }]);
    try {
      const runId = await interruptedRun(repo, env, scenarioPath, [...RUN_ARGS, "Override case"]);
      writeFileSync(scenarioPath, JSON.stringify({ calls: [planC, t1Edit, { failure: "hang" }, { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" }] }), "utf8");
      const resumed = spawnSync(process.execPath, [substrateMjs, "resume", runId, "--work", "claude:opus"], { cwd: repo.dir, env, encoding: "utf8", timeout: 120000 });
      expect(resumed.status, `${resumed.stdout.slice(-800)}\n${resumed.stderr.slice(-400)}`).toBe(0);
      const t2Starts = eventsOf(repo).filter((e) => e.type === "task.session.started" && e.data.task_id === "T2");
      expect(t2Starts.at(-1)?.data.model).toBe("opus");
    } finally {
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120000);
});
