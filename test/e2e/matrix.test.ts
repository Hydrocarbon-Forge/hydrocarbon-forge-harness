import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runSubstrate, withDefaultModels, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// Matrix of the SUBSTRATE-PLAN section 14 scenarios (1 to 16, as narrowed by R5.3
// Behavior 1) plus the extra rows of R5.3 Behavior 2 and 3. Every row runs the built
// CLI (dist/substrate.mjs) through runSubstrate against the fake executables, and
// asserts on the event log, the process exit code, the git state or the files on disk.

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SUBSTRATE_BIN = resolve(PROJECT_ROOT, "dist/substrate.mjs");
const FAKE_BIN_DIR = resolve(PROJECT_ROOT, "test/fixtures/fake-harness/bin");

type Dialect = "claude" | "opencode" | "agy";
const ALL_DIALECTS: Dialect[] = ["claude", "opencode", "agy"];

// Model ids per dialect. The planner and worker both use the dialect under test.
// The ids are the ones `run --request` accepts (its validator checks the catalogue).
const MODELS: Record<Dialect, { plan: string; work: string }> = {
  claude: { plan: "claude-sonnet-5-5", work: "haiku" },
  opencode: { plan: "opencode/deepseek-v4.1-flash-free", work: "opencode/deepseek-v4.1-flash-free" },
  agy: { plan: "gemini-3.8-flash-high", work: "gemini-3.8-flash-low" },
};

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];


interface RowContext {
  dialect: Dialect;
}

interface MatrixRow {
  id: string;
  name: string;
  dialects: Dialect[];
  run(ctx: RowContext): Promise<void>;
}

interface EventLike {
  seq: number;
  type: string;
  data: Record<string, any>;
}

function dialectSettings(dialect: Dialect): Record<string, unknown> {
  return {
    profiles: {
      [dialect]: {
        plan: { model: MODELS[dialect].plan, effort: "medium" },
        work: { model: MODELS[dialect].work, effort: "medium" },
      },
    },
    defaults: { planner_provider: dialect, worker_provider: dialect },
  };
}

// Points every backend at its fake executable. runSubstrate already does this by
// default; the matrix spells it out so no row can reach a real binary.
function fakeBackends(): Record<string, unknown> {
  return {
    backends: {
      claude: { bin: join(FAKE_BIN_DIR, "claude") },
      opencode: { bin: join(FAKE_BIN_DIR, "opencode") },
      agy: { bin: join(FAKE_BIN_DIR, "agy") },
    },
  };
}

function eventsOf(res: RunSubstrateResult): EventLike[] {
  return res.events.map((e) => ({
    seq: e.seq,
    type: e.type,
    data: (e.data ?? {}) as Record<string, any>,
  }));
}

function ofType(res: RunSubstrateResult, type: string): EventLike[] {
  return eventsOf(res).filter((e) => e.type === type);
}

function runIdOf(res: RunSubstrateResult): string {
  return (ofType(res, "run.created")[0]?.data.run_id as string) ?? "";
}

// Shown next to a failing exit-code assertion so the owner sees the CLI output.
function diagnostics(res: RunSubstrateResult): string {
  const types = res.events.map((e) => `${e.type}${e.data ? " " + JSON.stringify(e.data).slice(0, 300) : ""}`);
  return `stdout: ${res.stdout.slice(-1500)}\nstderr: ${res.stderr.slice(-1500)}\nevents: ${types.join("\n")}`;
}

function gitIn(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

// The agy adapter passes its child only an allowlisted environment, so the scenario
// path never reaches the fake agy. For agy rows the backend bin becomes a wrapper that
// exports the scenario path and runs the fake, as local-model.test.ts does for opencode.
// The wrapper is still a fake executable configured through backends.agy.bin.
function agyWrapperSettings(dialect: Dialect, scenarioPath: string, dir: string): Record<string, unknown> {
  if (dialect !== "agy") return {};
  const wrapper = join(dir, "agy-wrapper.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexport FAKE_SCENARIO_FILE='${scenarioPath}'\nexec '${join(FAKE_BIN_DIR, "agy")}' "$@"\n`,
    { mode: 0o755 },
  );
  return { backends: { agy: { bin: wrapper } } };
}

// Runs the built CLI against the fake executables of one dialect. The dialect's
// settings and the fake backend bins are merged in; row-specific settings win. When
// `calls` is given the scenario is written to a temp file; `env.FAKE_SCENARIO_FILE`
// names an existing scenario file instead.
function run(
  ctx: RowContext,
  options: {
    files?: Record<string, string>;
    calls?: unknown[];
    args: string[];
    settings?: Record<string, unknown>;
    env?: Record<string, string>;
    timeoutMs?: number;
    repo?: E2ERepo;
  },
): RunSubstrateResult {
  const dir = mkdtempSync(join(tmpdir(), "substrate-matrix-run-"));
  let scenarioPath = options.env?.FAKE_SCENARIO_FILE;
  if (options.calls) {
    scenarioPath = join(dir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify({ calls: options.calls }), "utf8");
  }
  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (scenarioPath) env.FAKE_SCENARIO_FILE = scenarioPath;
  const agy = scenarioPath ? agyWrapperSettings(ctx.dialect, scenarioPath, dir) : {};
  const settings = {
    ...fakeBackends(),
    ...dialectSettings(ctx.dialect),
    ...(options.settings ?? {}),
    ...agy,
  };
  const res = runSubstrate({
    repo: options.repo,
    files: options.files,
    // R7.2: run and plan need named models. The rows name the dialect under test's models.
    args: withDefaultModels(options.args, {
      planner: `${ctx.dialect}:${MODELS[ctx.dialect].plan}`,
      worker: `${ctx.dialect}:${MODELS[ctx.dialect].work}`,
    }),
    settings,
    env,
    timeoutMs: options.timeoutMs,
  });
  const cleanupRun = res.cleanup;
  return {
    ...res,
    cleanup() {
      cleanupRun();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The scenario rows share one shape: a seeded repo with a contract file, a planner
// call that writes the manifest, the task specs and the contract stub, then worker
// calls. The planner runs first because it is call 0 of every scenario.
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };

// Scenario 1: two independent tasks, both pass, the batch merges.
const row01: MatrixRow = {
  id: "S01",
  name: "all-pass batch: exit 0 and batch.merged",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const res = run(ctx, {
      files: SEED,
      calls: [
        planCall(contractFiles(manifestFor("All pass", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
        { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
        { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" },
      ],
      args: [...RUN_ARGS, "Run the all-pass batch"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(ofType(res, "batch.merged").length).toBeGreaterThanOrEqual(1);
      const merged = ofType(res, "task.merged").map((e) => e.data.task_id);
      expect(merged).toEqual(expect.arrayContaining(["T1", "T2"]));
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 2: attempt 1 fails verify, the one L0 heal fixes it in the same session.
const row02: MatrixRow = {
  id: "S02",
  name: "fail, heal, pass: exit 0 and task.healing with the real failing output",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const spec = taskSpec({
      id: "T1",
      write: ["src/a.txt"],
      verify: "grep -q marker src/a.txt || (echo missing-marker 1>&2; exit 1)",
    });
    const res = run(ctx, {
      files: SEED,
      calls: [
        planCall(contractFiles(manifestFor("Heal", ["T1"]), { "tasks/T1.md": spec })),
        { edits: { "src/a.txt": "seed a\nwrong line\n" }, reply: "appended without the marker\nDONE" },
        { edits: { "src/a.txt": "seed a\nwrong line\nmarker\n" }, reply: "the heal adds the marker\nDONE" },
      ],
      args: [...RUN_ARGS, "Run the heal case"],
    });
    try {
      const healing = ofType(res, "task.healing");
      expect(healing).toHaveLength(1);
      const failures = String(healing[0].data.failures ?? "");
      expect(failures).toContain("Command: grep -q marker");
      expect(failures).toContain("Exit code: 1");
      expect(failures).toContain("missing-marker");
      expect(ofType(res, "task.passed")).toHaveLength(1);
      expect(res.exitCode, diagnostics(res)).toBe(0);
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 3: two failing attempts write a failure packet, L1 revises the spec and the
// next generation passes against the revised spec.
const row03: MatrixRow = {
  id: "S03",
  name: "double fail, packet, L1 replan on the revised spec, pass: exit 0 and a packet file",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const spec = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q marker src/a.txt" });
    const revised = taskSpec({
      id: "T1",
      title: "Edit the allowed file with the revised marker",
      write: ["src/a.txt"],
      verify: "grep -q revised-marker src/a.txt",
      marker: "REVISED-SPEC-MARKER-7731",
    });
    const res = run(ctx, {
      files: SEED,
      calls: [
        planCall(contractFiles(manifestFor("Packet", ["T1"]), { "tasks/T1.md": spec })),
        { edits: { "src/a.txt": "seed a\n" }, reply: "attempt 1 has no marker\nDONE" },
        { edits: { "src/a.txt": "seed a\nwrong line\n" }, reply: "attempt 2 has no marker\nDONE" },
        { plan: { files: { "tasks/T1.md": revised } }, reply: "the spec asked for the wrong marker\nREVISED T1" },
        { edits: { "src/a.txt": "seed a\nrevised-marker\n" }, reply: "appended the revised marker\nDONE" },
      ],
      args: [...RUN_ARGS, "Run the packet case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const packetPath = join(res.runDir as string, "packets", "T1-g1.json");
      expect(existsSync(packetPath)).toBe(true);
      const packet = JSON.parse(readFileSync(packetPath, "utf8"));
      expect(packet.task_id).toBe("T1");
      expect(packet.generation).toBe(1);
      expect(packet.failure_class).toBe("verify_failed");
      expect(packet.attempts.length).toBe(2);
      expect(ofType(res, "replan.started")[0]?.data.generation).toBe(2);
      expect(ofType(res, "task.passed").length).toBeGreaterThanOrEqual(1);
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 4: an out-of-scope edit is reverted; verify decides the task.
const row04: MatrixRow = {
  id: "S04",
  name: "scope violation reverted: scope.checked lists it, the file is back at base, task passes",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const spec = taskSpec({
      id: "T1",
      write: ["src/a.txt"],
      verify: "grep -q \"seed b\" src/b.txt && grep -q marker src/a.txt",
    });
    const res = run(ctx, {
      files: SEED,
      calls: [
        planCall(contractFiles(manifestFor("Scope", ["T1"]), { "tasks/T1.md": spec })),
        {
          edits: { "src/a.txt": "seed a\nmarker\n", "src/b.txt": "out of scope change\n" },
          reply: "cannot complete the task\nBLOCKED",
        },
      ],
      args: [...RUN_ARGS, "Run the scope case"],
    });
    try {
      const scope = ofType(res, "scope.checked")[0];
      expect(scope).toBeDefined();
      expect((scope?.data.violations as string[]) ?? []).toContain("src/b.txt");
      // The finished run removes its worktrees (R8.1), so the reverted file is read from the
      // run branch, which holds what the task committed.
      expect(gitIn(res.repoDir, ["show", `substrate/runs/${runIdOf(res)}:src/b.txt`])).toBe("seed b");
      expect(ofType(res, "task.passed")).toHaveLength(1);
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 5: a protected file is modified; the task fails with protected_modified.
const row05: MatrixRow = {
  id: "S05",
  name: "protected file modified: task.failed with failure_class protected_modified",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const spec = taskSpec({
      id: "T1",
      write: ["src/a.txt"],
      protectedPaths: ["contracts/types.ts"],
      verify: "grep -q marker src/a.txt",
    });
    const res = run(ctx, {
      files: SEED,
      calls: [
        planCall(contractFiles(manifestFor("Protected", ["T1"]), { "tasks/T1.md": spec })),
        {
          edits: { "src/a.txt": "seed a\nmarker\n", "contracts/types.ts": "export {};\n// worker touched it\n" },
          reply: "DONE",
        },
      ],
      args: [...RUN_ARGS, "Run the protected case"],
    });
    try {
      const failed = ofType(res, "task.failed");
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0].data.failure_class).toBe("protected_modified");
      expect(ofType(res, "task.passed")).toHaveLength(0);
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 6: the harness reports a permission denial; the run pauses with exit 3.
// OpenCode is not in this row: its fake emits no tool event for a denial (S2), so the
// engine has nothing to observe.
const row06: MatrixRow = {
  id: "S06",
  name: "permission denial: exit 3 and run.paused with reason permission_denied",
  dialects: ["claude", "agy"],
  async run(ctx) {
    const spec = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q marker src/a.txt" });
    const res = run(ctx, {
      files: SEED,
      calls: [
        planCall(contractFiles(manifestFor("Denial", ["T1"]), { "tasks/T1.md": spec })),
        { failure: "permission_denial", reply: "tried a shell command" },
      ],
      args: [...RUN_ARGS, "Run the denial case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(3);
      const paused = ofType(res, "run.paused");
      expect(paused.length).toBeGreaterThanOrEqual(1);
      expect(paused[paused.length - 1].data.reason).toBe("permission_denied");
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 7: the run's cost budget is exhausted; the run pauses with exit 4.
// Only claude reports cost_usd in the fake (R0.2 Behavior 7), so only claude can drive
// a budget kill.
const row07: MatrixRow = {
  id: "S07",
  name: "budget kill: exit 4 and run.paused with reason budget_exhausted",
  dialects: ["claude"],
  async run(ctx) {
    const spec = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q marker src/a.txt" });
    const res = run(ctx, {
      files: SEED,
      calls: [
        { ...planCall(contractFiles(manifestFor("Budget", ["T1"]), { "tasks/T1.md": spec })), cost_usd: 0.00001 },
        { edits: { "src/a.txt": "seed a\nmarker\n" }, reply: "DONE", cost_usd: 0.0001 },
      ],
      settings: { budgets: { run: { max_usd: 0.00002 } } },
      args: [...RUN_ARGS, "Run the budget case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(4);
      const paused = ofType(res, "run.paused");
      expect(paused[paused.length - 1].data.reason).toBe("budget_exhausted");
    } finally {
      res.cleanup();
    }
  },
};

// Lists the processes whose environment names this scenario file. A hung fake that
// survived the timeout keeps that variable, so an empty list means no child is left.
function liveProcessesUsing(scenarioPath: string): number[] {
  const needle = `FAKE_SCENARIO_FILE=${scenarioPath}`;
  const alive: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (environ.split("\0").includes(needle)) alive.push(Number(entry));
    } catch {
      // The process exited while it was being listed, or belongs to another user.
    }
  }
  return alive;
}

// Scenario 8: a hanging session is killed by the task timeout, and no child survives.
const row08: MatrixRow = {
  id: "S08",
  name: "timeout kills the session: task.failed timeout and no live child process",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-matrix-timeout-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const spec = taskSpec({
      id: "T1",
      write: ["src/a.txt"],
      verify: "grep -q marker src/a.txt",
      budget: ["  max_usd: 0.5", "  timeout_min: 0.05"],
    });
    const revised = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q marker src/a.txt", marker: "AFTER-TIMEOUT" });
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        calls: [
          planCall(contractFiles(manifestFor("Timeout", ["T1"]), { "tasks/T1.md": spec })),
          { failure: "hang", reply: "never returns" },
          { plan: { files: { "tasks/T1.md": revised } }, reply: "REVISED T1" },
          { edits: { "src/a.txt": "seed a\nmarker\n" }, reply: "DONE" },
        ],
      }),
      "utf8",
    );
    const res = run(ctx, {
      files: SEED,
      args: [...RUN_ARGS, "Run the timeout case"],
      env: { FAKE_SCENARIO_FILE: scenarioPath },
      timeoutMs: 120000,
    });
    try {
      const failed = ofType(res, "task.failed");
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0].data.failure_class).toBe("timeout");
      expect(liveProcessesUsing(scenarioPath)).toEqual([]);
    } finally {
      res.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
    }
  },
};

// Scenario 9: two tasks edit the same file; the second merge conflicts and goes to L1.
const row09: MatrixRow = {
  id: "S09",
  name: "merge conflict: merge.conflict then task.failed merge_conflict, no replan, the run fails with exit 1 (R8.1)",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const t1 = taskSpec({ id: "T1", write: ["src/shared.txt"], verify: "grep -q t1-marker src/shared.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/shared.txt"], verify: "grep -q t2-marker src/shared.txt" });
    const res = run(ctx, {
      files: { "src/shared.txt": "initial shared content\n", "contracts/types.ts": CONTRACT_STUB },
      calls: [
        planCall(contractFiles(manifestFor("Conflict", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
        { task: "T1", edits: { "src/shared.txt": "t1-marker\n" }, reply: "T1 done\nDONE" },
        { task: "T2", edits: { "src/shared.txt": "t2-marker\n" }, reply: "T2 done\nDONE" },
      ],
      settings: { concurrency: { workers: 2 } },
      args: [...RUN_ARGS, "Run the conflict case"],
    });
    try {
      // R8.3: whichever task passes first merges; the other one conflicts with it.
      const loser = ofType(res, "merge.conflict")[0]?.data.task_id as string;
      expect(["T1", "T2"]).toContain(loser);
      const winner = loser === "T1" ? "T2" : "T1";
      const failed = ofType(res, "task.failed").find((e) => e.data.task_id === loser);
      expect(failed?.data.failure_class).toBe("merge_conflict");
      // The conflicting change is dropped: no replan, and the failure names the task that merged (R8.1).
      expect(failed?.data.can_replan).toBe(false);
      expect(String(failed?.data.detail)).toContain(winner);
      expect(ofType(res, "replan.started")).toHaveLength(0);
      expect(res.exitCode).toBe(1);
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 10: integration verify fails because of one task; bisect names it.
const row10: MatrixRow = {
  id: "S10",
  name: "integration failure: bisect.culprit names the task that created the bad file",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const t1 = taskSpec({ id: "T1", write: [], create: ["src/t1.txt"], verify: "test -f src/t1.txt" });
    const t2 = taskSpec({ id: "T2", write: [], create: ["src/bad.txt"], verify: "test -f src/bad.txt" });
    const res = run(ctx, {
      files: { "contracts/types.ts": CONTRACT_STUB },
      calls: [
        planCall(
          contractFiles(manifestFor("Bisect", ["T1", "T2"], "test ! -f src/bad.txt"), {
            "tasks/T1.md": t1,
            "tasks/T2.md": t2,
          }),
        ),
        { edits: { "src/t1.txt": "clean t1 content\n" }, reply: "T1 finished\nDONE" },
        { edits: { "src/bad.txt": "bad culprit content\n" }, reply: "T2 finished\nDONE" },
      ],
      args: [...RUN_ARGS, "Run the bisect case"],
    });
    try {
      expect(ofType(res, "bisect.started").length, diagnostics(res)).toBeGreaterThanOrEqual(1);
      expect(ofType(res, "bisect.culprit")[0]?.data.culprit_task_id).toBe("T2");
      const failed = ofType(res, "task.failed").find((e) => e.data.task_id === "T2");
      expect(failed?.data.failure_class).toBe("integration_failed");
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 11: crash and resume at every event boundary. For every index i of a
// finished reference run, a fresh identical run is cut to its first i events and then
// resumed. The fake's counter is the only state it keeps, so before each resume it is
// set to the number of planner calls the truncated log has already consumed (one once
// plan.produced is in the log, otherwise zero). Every worker call edits all three files,
// so whichever task consumes it, the task's own verify decides the outcome.
const row11: MatrixRow = {
  id: "S11",
  name: "crash and resume at every event boundary: resume exits 0 and the same tasks merge",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-matrix-boundary-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const manifest = manifestFor("Boundary", ["A", "B", "C"]);
    const planFiles = contractFiles(manifest, {
      "tasks/A.md": chainSpec("A", [], "src/a.txt", "A-done"),
      "tasks/B.md": chainSpec("B", ["A"], "src/b.txt", "B-done"),
      "tasks/C.md": chainSpec("C", ["B"], "src/c.txt", "C-done"),
    });
    const workerCall = {
      edits: {
        "src/a.txt": "seed a\nA-done\n",
        "src/b.txt": "seed b\nB-done\n",
        "src/c.txt": "seed c\nC-done\n",
      },
      reply: "DONE",
    };
    const calls = [
      planCall(planFiles),
      ...Array.from({ length: 12 }, () => workerCall),
    ];
    const seed = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };

    const finalMerged = (res: RunSubstrateResult) =>
      [...new Set(ofType(res, "task.merged").map((e) => e.data.task_id as string))].sort();

    // The scenario file is written once here and read by every run below through
    // FAKE_SCENARIO_FILE. Each run starts from a fresh counter.
    writeFileSync(scenarioPath, JSON.stringify({ calls }), "utf8");
    const reference = run(ctx, {
      files: seed,
      args: [...RUN_ARGS, "Run the boundary case"],
      env: { FAKE_SCENARIO_FILE: scenarioPath },
    });
    const referenceCount = reference.events.length;
    const referenceStates = finalMerged(reference);
    try {
      expect(reference.exitCode).toBe(0);
      expect(referenceStates).toEqual(["A", "B", "C"]);
      expect(referenceCount).toBeGreaterThan(1);
    } finally {
      reference.cleanup();
    }

    // The reference run is repeated for each boundary, so every cut starts from the
    // same log. The cut is applied to the run directory before the resume.
    const failures: string[] = [];
    for (let cut = 1; cut < referenceCount; cut++) {
      // Each cut blocks the worker for about one second (two spawnSync calls). Yielding
      // here lets vitest answer its RPC calls; without it the whole row held the worker
      // and onTaskUpdate timed out after 60 seconds.
      await yieldToEventLoop();
      const repo = createE2ERepo(seed);
      rmSync(`${scenarioPath}.state.json`, { force: true });
      const first = run(ctx, {
        repo,
        args: [...RUN_ARGS, "Run the boundary case"],
        env: { FAKE_SCENARIO_FILE: scenarioPath },
      });
      const runId = runIdOf(first);
      const eventsPath = join(first.runDir as string, "events.jsonl");
      const allLines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
      const kept = allLines.slice(0, cut);
      writeFileSync(eventsPath, kept.join("\n") + "\n", "utf8");

      const plannerDone = kept.some((line) => JSON.parse(line).type === "plan.produced");
      writeFileSync(`${scenarioPath}.state.json`, JSON.stringify({ next: plannerDone ? 1 : 0 }), "utf8");

      const resumed = run(ctx, {
        repo,
        args: ["resume", runId, "--permission-mode", "bypassPermissions"],
        env: { FAKE_SCENARIO_FILE: scenarioPath },
      });
      const states = finalMerged(resumed);
      const sameStates = JSON.stringify(states) === JSON.stringify(referenceStates);
      if (resumed.exitCode !== 0 || !sameStates) {
        failures.push(
          `cut ${cut} (last kept event: ${JSON.parse(kept[kept.length - 1]).type}): exit ${resumed.exitCode}, merged [${states.join(",")}]\n${diagnostics(resumed)}`,
        );
      }
      resumed.cleanup();
      first.cleanup();
    }
    rmSync(scenarioDir, { recursive: true, force: true });
    // Every cut is run; the failing ones are reported together.
    expect(failures, failures.join("\n\n")).toEqual([]);
  },
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function chainSpec(id: string, dependsOn: string[], file: string, marker: string): string {
  return taskSpec({
    id,
    title: `Write ${marker} in ${file}`,
    dependsOn,
    write: [file],
    verify: `grep -q "${marker}" ${file}`,
  });
}

// Scenario 12: rate limits back off, then the run pauses with exit 3.
const row12: MatrixRow = {
  id: "S12",
  name: "rate-limit backoff: rate_limit.backoff events, then run.paused rate_limited with exit 3",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const spec = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q marker src/a.txt" });
    const res = run(ctx, {
      files: SEED,
      calls: [
        planCall(contractFiles(manifestFor("Rate limit", ["T1"]), { "tasks/T1.md": spec })),
        { failure: "rate_limit", reply: "rate limit 1" },
        { failure: "rate_limit", reply: "rate limit 2" },
        { failure: "rate_limit", reply: "rate limit 3" },
        { failure: "rate_limit", reply: "rate limit 4" },
      ],
      settings: { concurrency: { workers: 8 } },
      args: [...RUN_ARGS, "Run the rate limit case"],
    });
    try {
      const backoffs = ofType(res, "rate_limit.backoff");
      expect(backoffs.length).toBeGreaterThanOrEqual(1);
      expect(backoffs[0].data.task_id).toBe("T1");
      expect(res.exitCode, diagnostics(res)).toBe(3);
      const paused = ofType(res, "run.paused");
      expect(paused[paused.length - 1].data.reason).toBe("rate_limited");
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 13: a planner reply with an unparseable manifest is retried in the same
// session and the corrected plan wins; when every attempt is bad the run exits 1.
const row13: MatrixRow = {
  id: "S13",
  name: "planner format retry: success after one retry, and exit 1 when retries are exhausted",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const spec = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q marker src/a.txt" });
    const good = planCall(contractFiles(manifestFor("Retry", ["T1"]), { "tasks/T1.md": spec }), "PLAN READY");
    const bad = { plan: { files: { "manifest.yaml": "goal: [unclosed bracket\n" } }, reply: "drafted the plan" };

    const retried = run(ctx, {
      files: SEED,
      calls: [bad, good],
      args: ["run", "--mode", "plan", "--permission-mode", "plan", "Run the retry case"],
    });
    try {
      expect(retried.exitCode).toBe(0);
      const usage = ofType(retried, "usage.recorded").filter((e) => e.data.role === "planner");
      expect(usage.length).toBe(2);
    } finally {
      retried.cleanup();
    }

    const exhausted = run(ctx, {
      files: SEED,
      calls: [bad, bad, bad],
      args: ["run", "--mode", "plan", "--permission-mode", "plan", "Run the exhausted case"],
    });
    try {
      expect(exhausted.exitCode, diagnostics(exhausted)).toBe(1);
      expect(ofType(exhausted, "task.failed")[0]?.data.failure_class).toBe("spec_invalid");
      expect(String(ofType(exhausted, "task.failed")[0]?.data.message)).toContain(
        "Planner format retries exhausted after 3 attempts: ",
      );
      // One attempt plus the two format retries (planner_format_retries defaults to 2).
      expect(ofType(exhausted, "usage.recorded").filter((e) => e.data.role === "planner").length).toBe(3);
    } finally {
      exhausted.cleanup();
    }
  },
};

// Scenario 14: an L2 amendment invalidates only the dependent that has not merged.
const row14: MatrixRow = {
  id: "S14",
  name: "L2 amendment: tasks.invalidated names T2 and never the merged T0",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const t0 = taskSpec({ id: "T0", write: ["src/t0.txt"], protectedPaths: ["contracts/types.ts"], verify: "grep -q t0-marker src/t0.txt" });
    const t1 = taskSpec({ id: "T1", dependsOn: ["T0"], write: ["src/t1.txt"], protectedPaths: ["contracts/types.ts"], verify: "grep -q t1-marker src/t1.txt" });
    const t2 = taskSpec({ id: "T2", dependsOn: ["T1"], write: ["src/t2.txt"], protectedPaths: ["contracts/types.ts"], verify: "grep -q t2-marker src/t2.txt" });
    const res = run(ctx, {
      files: { "src/t0.txt": "base\n", "src/t1.txt": "base\n", "src/t2.txt": "base\n", "contracts/types.ts": CONTRACT_STUB },
      calls: [
        planCall(contractFiles(manifestFor("Amend", ["T0", "T1", "T2"]), { "tasks/T0.md": t0, "tasks/T1.md": t1, "tasks/T2.md": t2 })),
        { edits: { "src/t0.txt": "base\nt0-marker\n" }, reply: "T0 done\nDONE" },
        { edits: { "contracts/types.ts": "export interface Amended { marker: string; }\n" }, reply: "T1 touched the contract\nDONE" },
        {
          plan: {
            files: {
              "manifest.yaml": manifestFor("Amend", ["T0", "T1", "T2"]),
              "contracts/amended.ts": "export interface Amended { marker: string; }\n",
            },
          },
          reply: "amended the contract and the manifest\nAMENDED",
        },
        { edits: { "src/t1.txt": "base\nt1-marker\n" }, reply: "T1 done\nDONE" },
        { edits: { "src/t2.txt": "base\nt2-marker\n" }, reply: "T2 done\nDONE" },
      ],
      settings: { budgets: { l1_replans_per_task: 0, l2_per_run: 1 }, concurrency: { workers: 1 } },
      args: [...RUN_ARGS, "Run the amendment case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const invalidated = ofType(res, "tasks.invalidated");
      expect(invalidated.length).toBe(1);
      expect(invalidated[0].data.task_ids).toEqual(["T2"]);
      expect(invalidated[0].data.task_ids).not.toContain("T0");
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 15: a request file with no governor setting in the settings runs with exit 0.
const row15: MatrixRow = {
  id: "S15",
  name: "request run with no governor setting: run --request exits 0",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const request = JSON.stringify({
      goal: "create feature.txt",
      mode: "solo",
      worker: { provider: ctx.dialect, model: MODELS[ctx.dialect].work },
      verify: ["test -f feature.txt"],
    });
    const res = run(ctx, {
      files: { "request.json": request },
      calls: [{ edits: { "feature.txt": "created\n" }, reply: "DONE" }],
      args: ["run", "--request", "request.json"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(ofType(res, "run.finished").pop()?.data.exit_code).toBe(0);
    } finally {
      res.cleanup();
    }
  },
};

// Scenario 16: solo mode, one worker, the verify from --verify decides the outcome.
const row16: MatrixRow = {
  id: "S16",
  name: "solo mode: exit 0 and the edit is verified and finished",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const res = run(ctx, {
      files: { "src/a.txt": "one\n" },
      calls: [{ edits: { "src/a.txt": "one\ntwo\n" }, reply: "DONE" }],
      settings: { git: { auto_merge: true } },
      args: ["run", "--mode", "solo", "--verify", "grep -q two src/a.txt", "add a line two to src/a.txt"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(ofType(res, "run.finished").pop()?.data.exit_code).toBe(0);
      expect(readFileSync(join(res.repoDir, "src/a.txt"), "utf8")).toBe("one\ntwo\n");
    } finally {
      res.cleanup();
    }
  },
};

// Extra row (R4.3): the local-model route runs as an OpenCode custom provider configured
// in settings.local.json. The base URL is a fake host, so no address is committed.
const rowLocal: MatrixRow = {
  id: "X01",
  name: "local-model route through OpenCode: provider block passed, local/<model> argv, no endpoint committed",
  dialects: ["opencode"],
  async run(ctx) {
    const tmp = mkdtempSync(join(tmpdir(), "substrate-matrix-local-"));
    const capturedConfig = join(tmp, "captured-opencode.json");
    const argvLog = join(tmp, "argv.log");
    const scenarioPath = join(tmp, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify({ calls: [{ reply: "DONE" }] }), "utf8");
    const wrapperPath = join(tmp, "opencode-wrapper.sh");
    writeFileSync(
      wrapperPath,
      `#!/bin/sh
if [ -f opencode.json ]; then
  cp opencode.json '${capturedConfig}'
fi
echo "$@" >> '${argvLog}'
export FAKE_SCENARIO_FILE='${scenarioPath}'
exec '${join(FAKE_BIN_DIR, "opencode")}' "$@"
`,
      { mode: 0o755 },
    );
    const localModel = "my-local-llama";
    const repo = createE2ERepo({});
    mkdirSync(join(repo.dir, ".substrate"), { recursive: true });
    writeFileSync(
      join(repo.dir, ".substrate", "settings.local.json"),
      JSON.stringify({
        backends: {
          opencode: {
            provider: {
              id: "local",
              npm: "@ai-sdk/openai-compatible",
              base_url: "http://fake.invalid/v1",
              models: { [localModel]: { name: "Local Llama Model" } },
            },
          },
        },
      }),
      "utf8",
    );
    const res = run(ctx, {
      settings: {
        backends: { opencode: { bin: wrapperPath } },
        profiles: { "local-profile": { plan: { model: "claude-sonnet-5-5" }, work: { model: localModel } } },
        defaults: { planner_provider: "local-profile", worker_provider: "local-profile" },
        roles: { worker: { backend: "opencode", model: localModel } },
      },
      // R7.2: the local model is named on the command line (the request path validates it).
      args: ["run", "--mode", "solo", "--work", `opencode:${localModel}`, "execute local worker"],
      repo,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(existsSync(capturedConfig)).toBe(true);
      const config = JSON.parse(readFileSync(capturedConfig, "utf8"));
      expect(config.provider.local.npm).toBe("@ai-sdk/openai-compatible");
      expect(config.provider.local.models?.[localModel]).toBeDefined();
      expect(readFileSync(argvLog, "utf8")).toContain(`local/${localModel}`);
      const grep = spawnSync("git", ["grep", "-nE", "https?://|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+:[0-9]+"], {
        cwd: res.repoDir,
        encoding: "utf8",
      });
      expect(grep.stdout.trim()).toBe("");
    } finally {
      res.cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  },
};

// Extra row (R3.2): SIGKILL while a task is running, then resume finishes the chain.
const rowSigkill: MatrixRow = {
  id: "X02",
  name: "SIGKILL while a task is running, then resume: all three tasks merged",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const repo = createE2ERepo({ "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB });
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-matrix-sigkill-"));
    const homeDir = mkdtempSync(join(tmpdir(), "substrate-matrix-home-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const allFiles = { "src/a.txt": "seed a\nA-done\n", "src/b.txt": "seed b\nB-done\n", "src/c.txt": "seed c\nC-done\n" };
    const chainCalls = [
      planCall(
        contractFiles(manifestFor("Kill chain", ["A", "B", "C"]), {
          "tasks/A.md": chainSpec("A", [], "src/a.txt", "A-done"),
          "tasks/B.md": chainSpec("B", ["A"], "src/b.txt", "B-done"),
          "tasks/C.md": chainSpec("C", ["B"], "src/c.txt", "C-done"),
        }),
      ),
      // The first worker call sleeps after its edit, so the kill lands while A runs.
      { edits: allFiles, reply: "DONE", delay_ms: 4000 },
      ...Array.from({ length: 6 }, () => ({ edits: allFiles, reply: "DONE" })),
    ];
    writeFileSync(scenarioPath, JSON.stringify({ calls: chainCalls }), "utf8");
    mkdirSync(join(repo.dir, ".substrate"), { recursive: true });
    writeFileSync(
      join(repo.dir, ".substrate", "settings.json"),
      JSON.stringify({ ...fakeBackends(), ...dialectSettings(ctx.dialect), ...agyWrapperSettings(ctx.dialect, scenarioPath, scenarioDir), concurrency: { workers: 1 } }, null, 2),
      "utf8",
    );
    const env = { ...process.env, HOME: homeDir, FAKE_SCENARIO_FILE: scenarioPath };
    // R7.2: run needs named models; this child is spawned directly, so it names them itself.
    const namedModels = ["--plan", `${ctx.dialect}:${MODELS[ctx.dialect].plan}`, "--work", `${ctx.dialect}:${MODELS[ctx.dialect].work}`];
    const child = spawn(process.execPath, [SUBSTRATE_BIN, ...RUN_ARGS, ...namedModels, "Run the kill chain"], { cwd: repo.dir, env });
    const exited = new Promise<number>((resolvePromise) => {
      child.on("exit", (code) => resolvePromise(code === null ? -1 : code));
    });

    const eventsPath = (): string | null => {
      const runsDir = join(repo.dir, ".substrate", "runs");
      if (!existsSync(runsDir)) return null;
      const dirs = readdirSync(runsDir);
      return dirs.length > 0 ? join(runsDir, dirs[0], "events.jsonl") : null;
    };
    const readEvents = (): Array<{ type: string; data?: Record<string, any> }> => {
      const path = eventsPath();
      if (!path || !existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    };

    try {
      let started = false;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !started) {
        started = readEvents().some((e) => e.type === "task.session.started" && e.data?.task_id === "A");
        if (!started) await new Promise((r) => setTimeout(r, 100));
      }
      expect(started).toBe(true);

      child.kill("SIGKILL");
      await exited;

      const runId = (readEvents().find((e) => e.type === "run.created")?.data?.run_id as string) ?? "";
      expect(runId).toBeTruthy();

      const resumed = spawnSync(process.execPath, [SUBSTRATE_BIN, "resume", runId, "--permission-mode", "bypassPermissions"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      expect(resumed.status).toBe(0);

      const merged = new Set(readEvents().filter((e) => e.type === "task.merged").map((e) => e.data?.task_id));
      expect([...merged].sort()).toEqual(["A", "B", "C"]);
      const finished = readEvents().filter((e) => e.type === "run.finished").pop();
      expect(finished?.data?.exit_code).toBe(0);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited.
      }
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  },
};

// Extra rows (R3.7): merge, undo and discard on a temp repo. None of them runs an
// executable, so one dialect is enough.
const rowMerge: MatrixRow = {
  id: "X03",
  name: "merge of a finished run: exit 0, HEAD gains a merge commit",
  dialects: ["claude"],
  async run(ctx) {
    const repo = createE2ERepo({ "README.md": "# Main branch\n" });
    const runId = "r_MATRIXMERGE";
    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      [
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-20T00:00:00Z", run_id: runId, type: "run.started" }),
        JSON.stringify({ v: 1, seq: 2, ts: "2026-10-20T00:00:01Z", run_id: runId, type: "run.finished", data: { exit_code: 0 } }),
      ].join("\n") + "\n",
      "utf8",
    );
    gitIn(repo.dir, ["checkout", "-b", `substrate/runs/${runId}`]);
    writeFileSync(join(repo.dir, "feature.txt"), "feature content\n", "utf8");
    gitIn(repo.dir, ["add", "feature.txt"]);
    gitIn(repo.dir, ["commit", "-m", "add feature"]);
    gitIn(repo.dir, ["checkout", "main"]);
    const headBefore = gitIn(repo.dir, ["rev-parse", "HEAD"]);

    const res = run(ctx, { repo, args: ["merge", runId] });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(res.stdout).toContain(`Merged substrate/runs/${runId} into main`);
      const headAfter = gitIn(repo.dir, ["rev-parse", "HEAD"]);
      expect(headAfter).not.toBe(headBefore);
      expect(gitIn(repo.dir, ["rev-parse", "HEAD^@"]).split(/\s+/).length).toBe(2);
    } finally {
      res.cleanup();
    }
  },
};

const rowUndo: MatrixRow = {
  id: "X04",
  name: "undo after two batches: the run branch moves back one checkpoint",
  dialects: ["claude"],
  async run(ctx) {
    const repo = createE2ERepo({ "README.md": "# Base\n" });
    const baseSha = gitIn(repo.dir, ["rev-parse", "HEAD"]);
    const runId = "r_MATRIXUNDO2";
    gitIn(repo.dir, ["checkout", "-b", `substrate/runs/${runId}`]);
    writeFileSync(join(repo.dir, "batch1.txt"), "batch 1\n", "utf8");
    gitIn(repo.dir, ["add", "batch1.txt"]);
    gitIn(repo.dir, ["commit", "-m", "batch 1 commit"]);
    const b1Sha = gitIn(repo.dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo.dir, "batch2.txt"), "batch 2\n", "utf8");
    gitIn(repo.dir, ["add", "batch2.txt"]);
    gitIn(repo.dir, ["commit", "-m", "batch 2 commit"]);
    const b2Sha = gitIn(repo.dir, ["rev-parse", "HEAD"]);
    gitIn(repo.dir, ["checkout", "main"]);

    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      [
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-20T00:00:00Z", run_id: runId, type: "run.started" }),
        JSON.stringify({ v: 1, seq: 2, ts: "2026-10-20T00:00:01Z", run_id: runId, type: "batch.merged", data: { batch: 1, checkpoint_ref: baseSha } }),
        JSON.stringify({ v: 1, seq: 3, ts: "2026-10-20T00:00:02Z", run_id: runId, type: "batch.merged", data: { batch: 2, checkpoint_ref: b1Sha } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = run(ctx, { repo, args: ["undo", runId] });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(res.stdout).toContain(`Reverted substrate/runs/${runId} to ${b1Sha}`);
      expect(gitIn(repo.dir, ["rev-parse", `substrate/runs/${runId}`])).toBe(b1Sha);
      expect(b1Sha).not.toBe(b2Sha);
    } finally {
      res.cleanup();
    }
  },
};

const rowDiscard: MatrixRow = {
  id: "X05",
  name: "discard of an inactive run: worktree directory and branches removed",
  dialects: ["claude"],
  async run(ctx) {
    const repo = createE2ERepo({ "README.md": "# Base\n" });
    const runId = "r_MATRIXDISCARD";
    gitIn(repo.dir, ["branch", `substrate/runs/${runId}`]);
    gitIn(repo.dir, ["branch", `substrate/tasks/${runId}/T1-g1`]);
    const wtDir = join(repo.dir, ".substrate", "worktrees", runId, "integration");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "temp.txt"), "worktree temp\n", "utf8");
    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({ v: 1, seq: 1, ts: "2026-10-20T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
      "utf8",
    );

    const res = run(ctx, { repo, args: ["discard", runId] });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(res.stdout).toContain(`Discarded run ${runId}`);
      expect(existsSync(join(repo.dir, ".substrate", "worktrees", runId))).toBe(false);
      const branches = gitIn(repo.dir, ["branch", "--list"]);
      expect(branches).not.toContain(`substrate/runs/${runId}`);
      expect(branches).not.toContain(`substrate/tasks/${runId}/T1-g1`);
    } finally {
      res.cleanup();
    }
  },
};

// Extra rows: --output-format json prints one JSON object, and stream-json prints one JSON
// object per line. Both are checked on a finished solo run.
const rowJson: MatrixRow = {
  id: "X06",
  name: "--output-format json: stdout parses as one JSON object with exit_code 0",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const res = run(ctx, {
      files: { "src/a.txt": "one\n" },
      calls: [{ edits: { "src/a.txt": "one\ntwo\n" }, reply: "DONE" }],
      args: ["run", "--mode", "solo", "--verify", "grep -q two src/a.txt", "--output-format", "json", "add a line two"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const doc = JSON.parse(res.stdout);
      expect(doc.status).toBe("finished");
      expect(Array.isArray(doc.events)).toBe(true);
      expect(doc.events.some((e: { type: string }) => e.type === "run.finished")).toBe(true);
    } finally {
      res.cleanup();
    }
  },
};

const rowStreamJson: MatrixRow = {
  id: "X07",
  name: "--output-format stream-json: every stdout line parses with JSON.parse",
  dialects: ALL_DIALECTS,
  async run(ctx) {
    const res = run(ctx, {
      files: { "src/a.txt": "one\n" },
      calls: [{ edits: { "src/a.txt": "one\ntwo\n" }, reply: "DONE" }],
      args: ["run", "--mode", "solo", "--verify", "grep -q two src/a.txt", "--output-format", "stream-json", "add a line two"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);
      const parsed = lines.map((line) => JSON.parse(line));
      expect(parsed.some((o: { type: string }) => o.type === "result")).toBe(true);
    } finally {
      res.cleanup();
    }
  },
};

// Final row (R5.3 Behavior 3): no interpolated val_ key and no console.log in the engine.
const rowGuards: MatrixRow = {
  id: "X08",
  name: "static guards: no val_${ in src and no console.log in src/engine",
  dialects: ["claude"],
  async run() {
    const valKey = spawnSync("git", ["grep", "-n", "val_${", "src"], { cwd: PROJECT_ROOT, encoding: "utf8" });
    const consoleLog = spawnSync("git", ["grep", "-n", "console.log", "src/engine"], { cwd: PROJECT_ROOT, encoding: "utf8" });
    expect(valKey.stdout).toBe("");
    expect(consoleLog.stdout).toBe("");
  },
};

const ROWS: MatrixRow[] = [
  row01,
  row02,
  row03,
  row04,
  row05,
  row06,
  row07,
  row08,
  row09,
  row10,
  row11,
  row12,
  row13,
  row14,
  row15,
  row16,
  rowLocal,
  rowSigkill,
  rowMerge,
  rowUndo,
  rowDiscard,
  rowJson,
  rowStreamJson,
  rowGuards,
];

const EXPECTED_ROW_IDS = [
  ...Array.from({ length: 16 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`),
  "X01",
  "X02",
  "X03",
  "X04",
  "X05",
  "X06",
  "X07",
  "X08",
];

function caseCount(): number {
  return ROWS.reduce((sum, row) => sum + row.dialects.length, 0);
}

describe("E2E matrix: every scenario and extra row through the built CLI (R5.3)", () => {
  it("the table holds the 16 scenario rows and every extra row, once each", () => {
    expect(ROWS.map((r) => r.id)).toEqual(EXPECTED_ROW_IDS);
    console.info(`E2E matrix: ${ROWS.length} rows, ${caseCount()} row x dialect cases`);
  });

  for (const row of ROWS) {
    for (const dialect of row.dialects) {
      it(`${row.id} [${dialect}] ${row.name}`, { timeout: 900000 }, async () => {
        await row.run({ dialect });
      });
    }
  }

  afterAll(() => {
    console.info(`E2E matrix finished: ${ROWS.length} rows, ${caseCount()} row x dialect cases`);
  });
});
