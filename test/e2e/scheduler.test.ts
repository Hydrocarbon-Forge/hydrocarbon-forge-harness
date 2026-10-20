import { describe, it, expect } from "vitest";

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";

interface EventLine {
  v: number;
  seq: number;
  ts: string;
  run_id: string;
  type: string;
  data: unknown;
}

/**
 * Plan for a three-task chain A -> B -> C. Each task's verify command checks a
 * marker its own worker writes, and B and C also check the marker of the task
 * they depend on: that only passes when the dependency had already been merged
 * into the run branch before the dependent started.
 */
const MANIFEST = [
  "version: 1",
  "run_id: r_CCCCCCCCCCCC",
  "goal: Add the marker chain",
  "base_ref: main",
  "ecosystem: node-ts",
  "setup:",
  "  - run: echo setup",
    "    timeout_s: 30",
  "contracts:",
  "  files:",
    "    - contracts/types.ts",
  "  typecheck:",
  "    - run: echo typecheck contracts",
    "      timeout_s: 30",
  "integration_verify:",
  "  - run: echo verify all",
    "    timeout_s: 60",
  "tasks:",
  "  - id: A",
    "    spec: tasks/A.md",
  "  - id: B",
    "    spec: tasks/B.md",
  "  - id: C",
    "    spec: tasks/C.md",
  "budget:",
  "  max_usd: 5",
  "  max_tokens: 200000",
  "  max_wall_min: 30",
  "",
].join("\n");

function spec(id: string, dependsOn: string[], file: string, marker: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: Write ${marker} in ${file}`,
    "class: feature",
    `depends_on: [${dependsOn.join(", ")}]`,
    "read:",
    "  - src/a.txt",
    "  - src/b.txt",
    "  - src/c.txt",
    "write:",
    `  - ${file}`,
    "create: []",
    "protected: []",
    "budget:",
    "  max_usd: 0.5",
    "  max_turns: 12",
    "verify:",
    `  - run: grep -q "${marker}" ${file}`,
      "    timeout_s: 10",
    "---",
    "",
    "## Objective",
    "",
    `Append ${marker} to ${file} and nothing else.`,
    "",
    "## Interface",
    "",
    "The file gains one line.",
    "",
    "## Behavior",
    "",
    `The line ${marker} is present after the task runs.`,
    "",
    "## Invariants",
    "",
    "No other file is modified.",
    "",
    "## Edge cases",
    "",
    "The file is not rewritten, only appended.",
    "",
    "## Guardrails",
    "",
    "No network access.",
    "",
    "## Out of scope",
    "",
    "Renaming the file.",
    "",
  ].join("\n");
}

function workerCall(marker: string, file: string, delayMs?: number) {
  const call: Record<string, unknown> = {
    append: { [file]: `${marker}\n` },
    reply: `appended ${marker}\nDONE`,
  };
  if (delayMs !== undefined) {
    call.delay_ms = delayMs;
  }
  return call;
}

const SEED_FILES = {
  "src/a.txt": "seed a\n",
  "src/b.txt": "seed b\n",
  "src/c.txt": "seed c\n",
  "contracts/types.ts": "export {};\n",
};

const CONTRACT_STUB = "export declare function markerName(): string;\n";

const PLAN_CALL = {
  plan: {
    files: {
      "manifest.yaml": MANIFEST,
      "tasks/A.md": spec("A", [], "src/a.txt", "A-done"),
      "tasks/B.md": spec("B", ["A"], "src/b.txt", "B-done"),
      "tasks/C.md": spec("C", ["B"], "src/c.txt", "C-done"),
      "contracts/types.ts": CONTRACT_STUB,
    },
  },
  reply: "wrote the plan for the chain\nPLAN READY",
};

const PROJECT_ROOT = resolve(__dirname, "../..");
const SUBSTRATE_BIN = resolve(PROJECT_ROOT, "dist/substrate.mjs");
const FAKE_BIN = resolve(PROJECT_ROOT, "test/fixtures/fake-harness/bin/claude");

interface Harness {
  repo: E2ERepo;
  scenarioPath: string;
  homeDir: string;
  settings: Record<string, unknown>;
  run(args: string[]): { exitCode: number; stdout: string; stderr: string };
  runDir(): string | null;
  events(): EventLine[];
  cleanup(): void;
}

function makeHarness(scenarioCalls: unknown[], settings: Record<string, unknown>): Harness {
  const repo = createE2ERepo(SEED_FILES);
  const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-e2e-scheduler-"));
  const homeDir = mkdtempSync(join(tmpdir(), "substrate-e2e-home-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ calls: scenarioCalls }), "utf8");

  const finalSettings = {
    backends: { claude: { bin: FAKE_BIN } },
    concurrency: { workers: 1 },
    ...settings,
  };

  const dotSubstrateDir = join(repo.dir, ".substrate");
  mkdirSync(dotSubstrateDir, { recursive: true });
  writeFileSync(
    join(dotSubstrateDir, "settings.json"),
    JSON.stringify(finalSettings, null, 2),
    "utf8"
  );

  const env = { ...process.env, HOME: homeDir, FAKE_SCENARIO_FILE: scenarioPath };

  return {
    repo,
    scenarioPath,
    homeDir,
    settings: finalSettings,
    run(args: string[]) {
      const proc = spawnSync(process.execPath, [SUBSTRATE_BIN, ...args], {
        cwd: repo.dir,
        input: "",
        encoding: "utf8",
        env,
        timeout: 120000,
      });
      return {
        exitCode: proc.status ?? 124,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
      };
    },
    runDir() {
      const runsDir = join(repo.dir, ".substrate", "runs");
      if (!existsSync(runsDir)) return null;
      const entries = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (entries.length === 0) return null;
      return join(runsDir, entries[0].name);
    },
    events() {
      const runDir = this.runDir();
      if (!runDir) return [];
      const eventsPath = join(runDir, "events.jsonl");
      if (!existsSync(eventsPath)) return [];
      return readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as EventLine;
          } catch {
            return null;
          }
        })
        .filter((e): e is EventLine => e !== null);
    },
    cleanup() {
      for (const dir of [scenarioDir, homeDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
      repo.cleanup();
    },
  };
}

function eventsOfType(events: EventLine[], type: string): EventLine[] {
  return events.filter((e) => e.type === type);
}

function dataOf(event: EventLine | undefined): Record<string, any> {
  return (event?.data ?? {}) as Record<string, any>;
}

describe("E2E scheduler: dependency order, terminal states, resume (R3.2)", () => {
  it("(a) a three-task chain runs in dependency order and exits 0", () => {
    const h = makeHarness(
      [
        PLAN_CALL,
        workerCall("A-done", "src/a.txt"),
        workerCall("B-done", "src/b.txt"),
        workerCall("C-done", "src/c.txt"),
      ],
      { budgets: { run: { max_usd: 5 } } }
    );

    try {
      const res = h.run(["run", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions", "Run the marker chain"]);
      expect(res.exitCode).toBe(0);

      const events = h.events();
      const finished = eventsOfType(events, "run.finished").pop();
      expect(dataOf(finished)?.exit_code).toBe(0);

      // B was readied only after A had been merged, and C only after B.
      const readyB = eventsOfType(events, "task.ready").find(
        (e) => dataOf(e).task_id === "B"
      );
      const mergedA = eventsOfType(events, "task.merged").find((e) => dataOf(e).task_id === "A");
      expect(mergedA).toBeDefined();
      expect(readyB).toBeDefined();
      expect(readyB!.seq).toBeGreaterThan(mergedA!.seq);

      const readyC = eventsOfType(events, "task.ready").find((e) => dataOf(e).task_id === "C");
      const mergedB = eventsOfType(events, "task.merged").find((e) => dataOf(e).task_id === "B");
      expect(mergedB).toBeDefined();
      expect(readyC).toBeDefined();
      expect(readyC!.seq).toBeGreaterThan(mergedB!.seq);

      // No task was readied before its dependency chain was merged.
      const readyIds = eventsOfType(events, "task.ready").map((e) => dataOf(e).task_id);
      expect(readyIds[0]).toBe("A");

      for (const id of ["A", "B", "C"]) {
        expect(eventsOfType(events, "task.merged").some((e) => dataOf(e).task_id === id)).toBe(
          true
        );
      }

      // B's and C's verify commands check the marker written by the task they
      // depend on, so the run can only finish with exit 0 when each dependent
      // started after its dependency had been merged into the run branch.
      expect(
        eventsOfType(events, "task.verify.finished").every((e) => dataOf(e).passed === true)
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("(b) a budget pause exits 4 and resume finishes the run", () => {
    // The planner is cheap; the first worker call exceeds the run budget, so the
    // run pauses with the task still in flight. The resume gets a larger budget
    // and completes the chain.
    const h = makeHarness(
      [
        { ...PLAN_CALL, cost_usd: 0.00001 },
        { ...workerCall("A-done", "src/a.txt"), cost_usd: 0.0001 },
        workerCall("A-done-again", "src/a.txt"),
        { ...workerCall("B-done", "src/b.txt"), cost_usd: 0.0001 },
        { ...workerCall("C-done", "src/c.txt"), cost_usd: 0.0001 },
      ],
      { budgets: { run: { max_usd: 0.00002 } } }
    );

    try {
      const paused = h.run(["run", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions", "Run the marker chain"]);
      expect(paused.exitCode).toBe(4);

      const pauseEvents = h.events();
      const pauseEvent = eventsOfType(pauseEvents, "run.paused").pop();
      expect(dataOf(pauseEvent)?.reason).toBe("budget_exhausted");
      expect(dataOf(pauseEvents.find((e) => e.type === "task.session.started"))?.task_id).toBe("A");

      const runId = dataOf(eventsOfType(pauseEvents, "run.created")[0])?.run_id;
      expect(runId).toBeTruthy();

      const resumed = h.run([
        "resume",
        runId,
        "--permission-mode",
        "bypassPermissions",
        "--max-budget-usd",
        "5",
      ]);
      expect(resumed.exitCode).toBe(0);

      const events = h.events();
      expect(eventsOfType(events, "run.resumed").length).toBe(1);

      // The task that was in flight when the run paused was put back in the queue.
      const readyA = eventsOfType(events, "task.ready").filter((e) => dataOf(e).resumed === true);
      expect(readyA.length).toBe(1);
      expect(dataOf(readyA[0]).task_id).toBe("A");

      const finished = eventsOfType(events, "run.finished").pop();
      expect(dataOf(finished)?.exit_code).toBe(0);

      for (const id of ["A", "B", "C"]) {
        expect(eventsOfType(events, "task.merged").some((e) => dataOf(e).task_id === id)).toBe(
          true
        );
      }

      for (const file of ["src/a.txt", "src/b.txt", "src/c.txt"]) {
        expect(readFileSync(join(h.repo.dir, file), "utf8")).toContain("seed");
      }
    } finally {
      h.cleanup();
    }
  });

  it("(c) SIGKILL while a task is RUNNING, then resume, finishes with all three merged", async () => {
    const h = makeHarness(
      [
        PLAN_CALL,
        // Consumed by the run that is killed: the harness applies the edit, then
        // sleeps while the engine waits for the session result.
        workerCall("A-killed", "src/a.txt", 4000),
        workerCall("A-done", "src/a.txt"),
        workerCall("B-done", "src/b.txt"),
        workerCall("C-done", "src/c.txt"),
      ],
      { budgets: { run: { max_usd: 5 } } }
    );

    try {
      const env = { ...process.env, HOME: h.homeDir, FAKE_SCENARIO_FILE: h.scenarioPath };
      const child = spawn(process.execPath, [SUBSTRATE_BIN, "run", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions", "Run the marker chain"], {
        cwd: h.repo.dir,
        env,
      });

      const exited = new Promise<number>((resolvePromise) => {
        child.on("exit", (code) => resolvePromise(code === null ? -1 : code));
      });

      // Wait until the engine has recorded the worker session for task A, so the
      // kill lands while that task is in flight.
      let started: EventLine | undefined;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const events = h.events();
        started = eventsOfType(events, "task.session.started").find((e) => dataOf(e).task_id === "A");
        if (started) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(started).toBeDefined();

      child.kill("SIGKILL");
      await exited;

      const killedEvents = h.events();
      const runId = dataOf(eventsOfType(killedEvents, "run.created")[0])?.run_id;
      expect(runId).toBeTruthy();

      // The log ends with task A in flight: nothing recorded the session ending.
      const lastForA = killedEvents.filter((e) => dataOf(e).task_id === "A").pop();
      expect(lastForA?.type).toBe("task.session.started");

      const resumed = h.run([
        "resume",
        runId,
        "--permission-mode",
        "bypassPermissions",
      ]);
      expect(resumed.exitCode).toBe(0);

      const events = h.events();
      const readyA = eventsOfType(events, "task.ready").filter((e) => dataOf(e).resumed === true);
      expect(readyA.length).toBe(1);

      const finished = eventsOfType(events, "run.finished").pop();
      expect(dataOf(finished)?.exit_code).toBe(0);

      for (const id of ["A", "B", "C"]) {
        expect(eventsOfType(events, "task.merged").some((e) => dataOf(e).task_id === id)).toBe(
          true
        );
      }

      // Sequence numbers keep increasing across the kill and the resume.
      const seqs = events.map((e) => e.seq);
      for (let i = 1; i < events.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    } finally {
      h.cleanup();
    }
  }, 60000);
});
