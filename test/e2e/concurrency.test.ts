import { describe, it, expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";
import { EventStoreImpl } from "../../src/store/event-store.js";
import type { RunId } from "../../src/contracts/index.js";
import { reduce, type EngineState } from "../../src/engine/reducer.js";

// R8.3: worker tasks run concurrently, up to concurrency.workers, each in its own worktree. The
// fake harness records when each worker session starts and ends (the trace call option) and
// whether a barrier with its siblings was met, so overlap is measured, not guessed.

const SEED = {
  "src/t1.txt": "seed t1\n",
  "src/t2.txt": "seed t2\n",
  "src/t3.txt": "seed t3\n",
  "contracts/types.ts": CONTRACT_STUB,
};
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");

interface Span {
  name: string;
  start: number;
  end: number;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The spans of named worker sessions: start at the trace start, end at the process exit (Infinity if none). */
function spansOf(dir: string, names: string[]): Span[] {
  return names.map((name) => {
    const start = readJson(join(dir, `start-${name}.json`)).at as number;
    const endFile = join(dir, `end-${name}.json`);
    const end = existsSync(endFile) ? (readJson(endFile).at as number) : Number.POSITIVE_INFINITY;
    return { name, start, end };
  });
}

/** The most sessions alive at one moment. A session ends before another starts at the same instant. */
function maxOverlap(spans: Span[]): number {
  const points: Array<{ t: number; d: number }> = [];
  for (const s of spans) {
    points.push({ t: s.start, d: 1 });
    points.push({ t: s.end, d: -1 });
  }
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let alive = 0;
  let max = 0;
  for (const p of points) {
    alive += p.d;
    max = Math.max(max, alive);
  }
  return max;
}

function overlapping(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function mergedOrder(res: RunSubstrateResult): string[] {
  return res.events.filter((e) => e.type === "task.merged").map((e) => (e.data as any).task_id);
}

function diagnostics(res: RunSubstrateResult): string {
  return `stdout: ${res.stdout.slice(-1500)}\nstderr: ${res.stderr.slice(-800)}`;
}

/** A traced worker call for a task: it writes its start and end, and waits for its barrier names. */
function traced(
  task: string,
  dir: string,
  opts: { edit?: string; content?: string; delay?: number; waitFor?: string[]; timeout?: number; failure?: string; cost?: number } = {}
): Record<string, unknown> {
  return {
    task,
    ...(opts.edit ? { edits: { [opts.edit]: opts.content ?? `seed ${task}\n${task.toLowerCase()}-done\n` } } : {}),
    trace: { dir, name: task, ...(opts.waitFor ? { wait_for: opts.waitFor, timeout_ms: opts.timeout ?? 5000 } : {}) },
    ...(opts.delay !== undefined ? { delay_ms: opts.delay } : {}),
    ...(opts.failure ? { failure: opts.failure } : {}),
    ...(opts.cost !== undefined ? { cost_usd: opts.cost } : {}),
    reply: `${task} done\nDONE`,
  };
}

function independentSpecs(ids: string[]): Record<string, string> {
  const specs: Record<string, string> = {};
  for (const id of ids) {
    specs[`tasks/${id}.md`] = taskSpec({ id, write: [`src/${id.toLowerCase()}.txt`], verify: `grep -q ${id.toLowerCase()}-done src/${id.toLowerCase()}.txt` });
  }
  return specs;
}

function runPlan(
  ids: string[],
  calls: unknown[],
  settings: Record<string, unknown>,
  extra: { timeoutMs?: number; env?: Record<string, string> } = {}
): RunSubstrateResult {
  const specs = independentSpecs(ids);
  return runSubstrate({
    files: SEED,
    scenario: { calls: [planCall(contractFiles(manifestFor("Concurrent", ids), specs)), ...calls] },
    settings,
    args: [...RUN_ARGS, "Concurrent case"],
    timeoutMs: extra.timeoutMs ?? 120000,
    env: extra.env,
  });
}

function barrierMet(dir: string, name: string): boolean {
  return readJson(join(dir, `barrier-${name}.json`)).met === true;
}

describe("R8.3: worker tasks run concurrently, up to concurrency.workers", () => {
  it("three independent tasks with three workers run side by side: every barrier with its siblings is met", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-conc-a-"));
    const started = Date.now();
    const res = runPlan(
      ["T1", "T2", "T3"],
      [
        traced("T1", dir, { edit: "src/t1.txt", delay: 1500, waitFor: ["T2", "T3"] }),
        traced("T2", dir, { edit: "src/t2.txt", delay: 1500, waitFor: ["T1", "T3"] }),
        traced("T3", dir, { edit: "src/t3.txt", delay: 1500, waitFor: ["T1", "T2"] }),
      ],
      { concurrency: { workers: 3 } }
    );
    const elapsed = Date.now() - started;
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      for (const name of ["T1", "T2", "T3"]) expect(barrierMet(dir, name), `barrier ${name}`).toBe(true);
      expect(maxOverlap(spansOf(dir, ["T1", "T2", "T3"]))).toBe(3);
      // Three 1.5 s tasks in sequence need 4.5 s of work; side by side they need about 1.5 s.
      expect(elapsed, `elapsed ${elapsed} ms`).toBeLessThan(3500);
      expect(mergedOrder(res).sort()).toEqual(["T1", "T2", "T3"]);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);

  it("with concurrency.workers 1 the same plan does not overlap: each barrier times out, no two sessions overlap, and it takes about three task times", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-conc-b-"));
    const started = Date.now();
    const res = runPlan(
      ["T1", "T2", "T3"],
      [
        traced("T1", dir, { edit: "src/t1.txt", delay: 1500, waitFor: ["T2", "T3"], timeout: 300 }),
        traced("T2", dir, { edit: "src/t2.txt", delay: 1500, waitFor: ["T1", "T3"], timeout: 300 }),
        traced("T3", dir, { edit: "src/t3.txt", delay: 1500, waitFor: ["T1", "T2"], timeout: 300 }),
      ],
      { concurrency: { workers: 1 } }
    );
    const elapsed = Date.now() - started;
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      for (const name of ["T1", "T2", "T3"]) expect(barrierMet(dir, name), `barrier ${name}`).toBe(false);
      expect(maxOverlap(spansOf(dir, ["T1", "T2", "T3"]))).toBe(1);
      expect(elapsed, `elapsed ${elapsed} ms`).toBeGreaterThanOrEqual(4500);
      expect(mergedOrder(res).sort()).toEqual(["T1", "T2", "T3"]);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);

  it("with concurrency.workers 2 and three independent tasks, never more than two workers are alive at once", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-conc-c-"));
    const res = runPlan(
      ["T1", "T2", "T3"],
      [
        traced("T1", dir, { edit: "src/t1.txt", delay: 1000 }),
        traced("T2", dir, { edit: "src/t2.txt", delay: 1000 }),
        traced("T3", dir, { edit: "src/t3.txt", delay: 1000 }),
      ],
      { concurrency: { workers: 2 } }
    );
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const spans = spansOf(dir, ["T1", "T2", "T3"]);
      expect(maxOverlap(spans)).toBe(2);
      expect(mergedOrder(res).sort()).toEqual(["T1", "T2", "T3"]);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing task does not stop its running sibling: the sibling is merged and the dependent is skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-conc-d-"));
    const t1 = taskSpec({ id: "T1", write: ["src/t1.txt"], verify: "grep -q t1-done src/t1.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/t2.txt"], verify: "grep -q t2-done src/t2.txt" });
    const t3 = taskSpec({ id: "T3", write: ["src/t3.txt"], dependsOn: ["T1"], verify: "grep -q t3-done src/t3.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Sibling", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
          // T1 crashes while T2 is still running; T1's two replan sessions are untagged calls.
          traced("T1", dir, { failure: "crash", waitFor: ["T2"], timeout: 5000 }),
          traced("T2", dir, { edit: "src/t2.txt", delay: 1500, waitFor: ["T1"], timeout: 5000 }),
          { failure: "crash" },
          { failure: "crash" },
          ...Array.from({ length: 6 }, () => ({ reply: "DONE" })),
        ],
      },
      settings: { concurrency: { workers: 2 } },
      args: [...RUN_ARGS, "Sibling case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      expect(barrierMet(dir, "T2"), "T2 was running when T1 failed").toBe(true);
      const failed = res.events.find((e) => e.type === "task.failed" && (e.data as any).task_id === "T1");
      expect((failed?.data as any).failure_class).toBe("worker_crashed");
      expect(mergedOrder(res)).toEqual(["T2"]);
      const skipped = res.events.find((e) => e.type === "task.skipped" && (e.data as any).task_id === "T3");
      expect((skipped?.data as any).failed).toEqual(["T1"]);
      expect(res.events.some((e) => e.type === "task.session.started" && (e.data as any).task_id === "T3")).toBe(false);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a dependency chain beside an independent task: T3 overlaps T1, and T2 starts only after T1 is merged", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-conc-e-"));
    const t1 = taskSpec({ id: "T1", write: ["src/t1.txt"], verify: "grep -q t1-done src/t1.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/t2.txt"], dependsOn: ["T1"], verify: "grep -q t2-done src/t2.txt" });
    const t3 = taskSpec({ id: "T3", write: ["src/t3.txt"], verify: "grep -q t3-done src/t3.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Chain", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
          traced("T1", dir, { edit: "src/t1.txt", delay: 800 }),
          traced("T3", dir, { edit: "src/t3.txt", delay: 1800 }),
          traced("T2", dir, { edit: "src/t2.txt", delay: 300 }),
        ],
      },
      settings: { concurrency: { workers: 2 } },
      args: [...RUN_ARGS, "Chain case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const [s1, s2, s3] = spansOf(dir, ["T1", "T2", "T3"]);
      expect(overlapping(s1, s3), "T3 runs while T1 runs").toBe(true);
      const mergedT1 = res.events.find((e) => e.type === "task.merged" && (e.data as any).task_id === "T1");
      expect(mergedT1, "T1 merged").toBeDefined();
      expect(s2.start).toBeGreaterThanOrEqual(Date.parse(mergedT1!.ts));
      expect(mergedOrder(res).sort()).toEqual(["T1", "T2", "T3"]);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the journal of a concurrent run has unique, strictly increasing sequence numbers, and replays to the status the CLI reports", () => {
    const res = runPlan(
      ["T1", "T2", "T3"],
      [
        { task: "T1", edits: { "src/t1.txt": "seed\nt1-done\n" }, delay_ms: 300, reply: "DONE" },
        { task: "T2", edits: { "src/t2.txt": "seed\nt2-done\n" }, delay_ms: 100, reply: "DONE" },
        { task: "T3", edits: { "src/t3.txt": "seed\nt3-done\n" }, delay_ms: 200, reply: "DONE" },
      ],
      { concurrency: { workers: 3 } }
    );
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const seqs = res.events.map((e) => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      expect(new Set(seqs).size).toBe(seqs.length);

      const runId = res.runDir!.split("/").pop() as RunId;
      const replayed = replayRun(res.repoDir, runId);
      const status = spawnSync(process.execPath, [substrateMjs, "status", "--output-format", "json", runId], {
        cwd: res.repoDir,
        encoding: "utf8",
      });
      expect(status.status, status.stderr).toBe(0);
      const reported = JSON.parse(status.stdout);
      const replayedTasks = Object.values(replayed.tasks)
        .map((t: any) => ({ id: t.id, state: t.state }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const reportedTasks = Object.entries(reported.tasks as Record<string, { state: string }>)
        .map(([id, t]) => ({ id, state: t.state }))
        .sort((x, y) => x.id.localeCompare(y.id));
      expect(reportedTasks).toEqual(replayedTasks);
      expect(replayed.state).toBe(reported.state);
      expect(replayed.usage.total_usd).toBeCloseTo(reported.usage.total_usd, 10);
      expect(replayedTasks.every((t) => t.state === "MERGED")).toBe(true);
    } finally {
      res.cleanup();
    }
  });
});

describe("R8.3: interrupts and budgets stop every in-flight worker", () => {
  it("SIGINT during a concurrent run kills both workers, exits 130, and a resume finishes without redoing the passed task", async () => {
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-conc-scn-"));
    const traceDir = mkdtempSync(join(tmpdir(), "substrate-conc-trace-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const e2e = createE2ERepo(SEED);
    const homeDir = mkdtempSync(join(tmpdir(), "substrate-conc-home-"));
    const specs = independentSpecs(["T1", "T2", "T3"]);
    const settingsDir = join(e2e.dir, ".substrate");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        backends: { claude: { bin: join(binDir, "claude") }, opencode: { bin: join(binDir, "opencode") }, agy: { bin: join(binDir, "agy") } },
        concurrency: { workers: 3 },
      }),
      "utf8"
    );
    const calls: unknown[] = [
      planCall(contractFiles(manifestFor("Interrupt", ["T1", "T2", "T3"]), specs)),
      traced("T1", traceDir, { failure: "hang" }),
      traced("T2", traceDir, { failure: "hang" }),
      traced("T3", traceDir, { edit: "src/t3.txt", delay: 0 }),
    ];
    writeFileSync(scenarioPath, JSON.stringify({ calls }), "utf8");
    const env = { ...process.env, HOME: homeDir, FAKE_SCENARIO_FILE: scenarioPath };
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, [substrateMjs, "run", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions", "Interrupt case"], {
        cwd: e2e.dir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<number | null>((res) => child!.on("exit", (code) => res(code)));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !(existsSync(join(traceDir, "start-T1.json")) && existsSync(join(traceDir, "start-T2.json")))) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(join(traceDir, "start-T1.json")) && existsSync(join(traceDir, "start-T2.json"))).toBe(true);
      const pids = [readJson(join(traceDir, "start-T1.json")).pid as number, readJson(join(traceDir, "start-T2.json")).pid as number];
      for (const pid of pids) expect(pidAlive(pid)).toBe(true);

      // T3 passes and merges while T1 and T2 hang: the interrupt comes after that merge, so the
      // resume has only T1 and T2 to do.
      const runsDir = join(e2e.dir, ".substrate", "runs");
      const mergedT3 = (): boolean => {
        const runId = existsSync(runsDir) ? readdirSync(runsDir).sort().at(-1) : undefined;
        if (!runId) return false;
        const file = join(runsDir, runId, "events.jsonl");
        return existsSync(file) && readFileSync(file, "utf8").split("\n").some((l) => l.includes('"task.merged"') && l.includes('"T3"'));
      };
      const mergeDeadline = Date.now() + 30000;
      while (Date.now() < mergeDeadline && !mergedT3()) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(mergedT3(), "T3 merged before the interrupt").toBe(true);

      child.kill("SIGINT");
      const code = await exited;
      expect(code).toBe(130);
      for (const pid of pids) expect(pidAlive(pid), `worker ${pid} gone`).toBe(false);

      const runId = readdirSync(join(e2e.dir, ".substrate", "runs")).sort().at(-1) as string;
      // The resume: T1 and T2 get their second calls, which pass; T3 already merged and is not run again.
      const resumeCalls = [
        traced("T1", traceDir, { edit: "src/t1.txt" }),
        traced("T2", traceDir, { edit: "src/t2.txt" }),
      ];
      writeFileSync(scenarioPath, JSON.stringify({ calls: [...calls, ...resumeCalls] }), "utf8");
      const resumed = spawnSync(process.execPath, [substrateMjs, "resume", runId, "--permission-mode", "bypassPermissions"], {
        cwd: e2e.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      expect(resumed.status, `resume stdout: ${resumed.stdout.slice(-1200)}\nstderr: ${resumed.stderr.slice(-600)}`).toBe(0);
      const events = readRunEvents(e2e.dir, runId);
      const t3Sessions = events.filter((e) => e.type === "task.session.started" && e.data.task_id === "T3");
      expect(t3Sessions).toHaveLength(1);
      const merged = events.filter((e) => e.type === "task.merged").map((e) => e.data.task_id).sort();
      expect(merged).toEqual(["T1", "T2", "T3"]);
    } finally {
      child?.kill("SIGKILL");
      e2e.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(traceDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120000);

  it("two tasks finishing at the same moment both merge, with no index.lock error", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-conc-merge-"));
    const res = runPlan(
      ["T1", "T2"],
      [
        traced("T1", dir, { edit: "src/t1.txt", delay: 800 }),
        traced("T2", dir, { edit: "src/t2.txt", delay: 800 }),
      ],
      { concurrency: { workers: 2 } }
    );
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(res.stdout + res.stderr).not.toMatch(/index\.lock/);
      expect(mergedOrder(res).sort()).toEqual(["T1", "T2"]);
      const runBranch = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/substrate/runs/"], { cwd: res.repoDir, encoding: "utf8" }).stdout.trim();
      expect(runBranch.split("\n")).toHaveLength(1);
      const show = (path: string) => spawnSync("git", ["show", `${runBranch}:${path}`], { cwd: res.repoDir, encoding: "utf8" }).stdout;
      expect(show("src/t1.txt")).toContain("t1-done");
      expect(show("src/t2.txt")).toContain("t2-done");
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== "ESRCH";
  }
}

function readRunEvents(repoDir: string, runId: string): Array<{ type: string; data: any; seq: number }> {
  return readFileSync(join(repoDir, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Replays a run's log from its first event, the way the engine rebuilds state on resume. */
function replayRun(repoDir: string, runId: RunId): EngineState {
  const store = new EventStoreImpl(runId, { runDir: join(repoDir, ".substrate", "runs", runId) });
  let state: EngineState = { run_id: runId, state: "CREATED", tasks: {}, usage: { total_usd: 0, by_role: {} }, checkpoints: [] };
  for (const evt of store.readAllSync()) {
    state = reduce(state, evt);
    if (evt.type === "run.finished") {
      state = { ...state, state: (evt.data as any)?.exit_code === 0 ? "FINISHED" : "FAILED" };
    }
  }
  return state;
}
