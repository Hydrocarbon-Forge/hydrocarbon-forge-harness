// Spend and time limits are opt-in (owner, 2026-10-21). With no limit set, a run is never ended for its
// cost or its time, the estimate never pauses it, and no harness receives a cap it was not given. A
// spec's budget is an advisory estimate. Each case runs the built CLI with the fake harness in a scratch repo.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";

const CONTRACT_STUB = "export {};\n";
const SEED = { "src/feature.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB };
const ARGS = ["run", "Run the opt-in limits case"];
const binDir = resolve(__dirname, "../fixtures/fake-harness/bin");
const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");

type Ev = { type: string; data: Record<string, unknown> };

function manifestFor(runId: string, taskIds: string[]): string {
  return [
    "version: 1",
    `run_id: ${runId}`,
    "goal: Opt-in limits case",
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
    ...taskIds.flatMap((id) => [`  - id: ${id}`, `    spec: tasks/${id}.md`]),
    "",
  ].join("\n");
}

/** A task that writes one file. `budgetLines` is the spec's advisory budget (default: the old $0.50 figure). */
function taskSpec(id: string, file: string, budgetLines: string[] = ["  max_usd: 0.5"]): string {
  return [
    "---",
    `id: ${id}`,
    `title: Edit ${file}`,
    "class: feature",
    "depends_on: []",
    "read:",
    "  - contracts/types.ts",
    "write:",
    `  - ${file}`,
    "create: []",
    "protected: []",
    "budget:",
    ...budgetLines,
    "verify:",
    `  - run: grep -q marker ${file}`,
    "    timeout_s: 10",
    "---",
    "",
    "## Objective",
    "",
    `Write one line in ${file} and nothing else.`,
    "",
    "## Interface",
    "",
    "The file gains the marker line.",
    "",
    "## Behavior",
    "",
    "The marker line is present after the task runs.",
    "",
    "## Invariants",
    "",
    "No other file is modified.",
    "",
    "## Edge cases",
    "",
    "The file is appended, not rewritten.",
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

function planCall(manifest: string, specs: Record<string, string>, finishLine = "PLAN READY"): Record<string, unknown> {
  return {
    plan: { files: { "manifest.yaml": manifest, ...specs, "contracts/types.ts": CONTRACT_STUB } },
    reply: `wrote the plan for the limits case\n${finishLine}`,
  };
}

/** A worker session that edits one file and reports `costUsd` for the call. */
function workerCall(file: string, costUsd: number): Record<string, unknown> {
  return { edits: { [file]: "seed\nmarker\n" }, cost_usd: costUsd, reply: `edited ${file}\nDONE` };
}

function eventsOf(res: RunSubstrateResult, type: string): Ev[] {
  return res.events.filter((e) => e.type === type).map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

/** A claude wrapper that appends each call's argv to a log, then runs the fake claude. */
function argvWrapper(dir: string): { bin: string; log: string } {
  const log = join(dir, "argv.log");
  const bin = join(dir, "claude-argv");
  writeFileSync(bin, `#!/bin/sh\nexport FAKE_ARGV_LOG='${log}'\nexec '${join(binDir, "claude")}' "$@"\n`, "utf8");
  chmodSync(bin, 0o755);
  return { bin, log };
}

function loggedArgv(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { argv: string[] }).argv);
}

describe("opt-in limits: no cap, no kill, no pause unless the caller sets one", () => {
  it("(a) a worker that costs $2.00, above the old $0.50 task cap, completes and merges with no limits set", () => {
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-limits-a-"));
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [planCall(manifestFor("r_AAAAAAAAAAAA", ["T1"]), { "tasks/T1.md": taskSpec("T1", "src/feature.txt") }), workerCall("src/feature.txt", 2.0)],
      },
      args: ARGS,
      timeoutMs: 120000,
    });
    try {
      expect(res.exitCode, `${res.stdout.slice(-600)}\n${res.stderr.slice(-400)}`).toBe(0);
      expect(eventsOf(res, "task.passed")).toHaveLength(1);
      expect(eventsOf(res, "task.failed")).toEqual([]);
      expect(eventsOf(res, "run.budget.exceeded")).toEqual([]);
      expect(eventsOf(res, "run.paused")).toEqual([]);
      expect(readFileSync(join(res.repoDir, "src/feature.txt"), "utf8")).toContain("marker");
      // The run records that it has no run cap, and the planner's request says so.
      const created = eventsOf(res, "run.created")[0];
      expect(created.data.max_budget_usd).toBeNull();
      expect(created.data.time_limit_s).toBeNull();
      expect(readFileSync(join(res.runDir as string, "planner-request.md"), "utf8")).toMatch(/per-task cap: no limit\s*\n- run cap: no limit/);
    } finally {
      res.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
    }
  }, 150000);

  it("(b) a plan whose estimate is above the old $2 threshold runs without needs_approval under the default dontAsk mode", () => {
    const ids = ["T1", "T2", "T3", "T4"];
    const files = ids.map((id) => `src/${id.toLowerCase()}.txt`);
    const specs = Object.fromEntries(ids.map((id, i) => [`tasks/${id}.md`, taskSpec(id, files[i], ["  max_usd: 1.5"])]));
    const res = runSubstrate({
      files: { ...SEED, ...Object.fromEntries(files.map((f) => [f, "seed\n"])) },
      scenario: {
        calls: [planCall(manifestFor("r_BBBBBBBBBBBB", ids), specs), ...files.map((f) => workerCall(f, 0.01))],
      },
      args: ARGS,
      timeoutMs: 120000,
    });
    try {
      expect(eventsOf(res, "run.paused").map((e) => e.data.reason)).not.toContain("needs_approval");
      expect(eventsOf(res, "plan.approved")).toHaveLength(1);
      expect(res.exitCode, `${res.stdout.slice(-600)}\n${res.stderr.slice(-400)}`).toBe(0);
      expect(eventsOf(res, "task.passed")).toHaveLength(4);
    } finally {
      res.cleanup();
    }
  }, 150000);

  it("(c) a spec budget is advisory: a $0.50 worker under budget max_usd 0.01 is not killed; the same run with settings budgets.task.max_usd 0.1 is", () => {
    const manifest = manifestFor("r_CCCCCCCCCCCC", ["T1"]);
    const spec = taskSpec("T1", "src/feature.txt", ["  max_usd: 0.01"]);

    const advisory = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(manifest, { "tasks/T1.md": spec }), workerCall("src/feature.txt", 0.5)] },
      args: ARGS,
      timeoutMs: 120000,
    });
    try {
      expect(eventsOf(advisory, "task.failed")).toEqual([]);
      expect(eventsOf(advisory, "task.passed")).toHaveLength(1);
      expect(advisory.exitCode).toBe(0);
    } finally {
      advisory.cleanup();
    }

    const enforced = runSubstrate({
      files: SEED,
      scenario: {
        calls: [planCall(manifest, { "tasks/T1.md": spec }), workerCall("src/feature.txt", 0.5), planCall(manifest, { "tasks/T1.md": spec }, "REVISED T1"), workerCall("src/feature.txt", 0)],
      },
      settings: { budgets: { task: { max_usd: 0.1 } } },
      args: ARGS,
      timeoutMs: 120000,
    });
    try {
      const failed = eventsOf(enforced, "task.failed");
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0].data.failure_class).toBe("budget_exceeded");
      expect(eventsOf(enforced, "run.paused")).toEqual([]);
    } finally {
      enforced.cleanup();
    }
  }, 300000);

  it("(d) --max-budget-usd 0.3 still stops the run at the cap, exit 4, budget_exhausted", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(manifestFor("r_DDDDDDDDDDDD", ["T1"]), { "tasks/T1.md": taskSpec("T1", "src/feature.txt") }), workerCall("src/feature.txt", 0.5)] },
      args: [...ARGS.slice(0, 1), "--max-budget-usd", "0.3", ...ARGS.slice(1)],
      timeoutMs: 120000,
    });
    try {
      expect(res.exitCode).toBe(4);
      const paused = eventsOf(res, "run.paused");
      expect(paused.at(-1)?.data.reason).toBe("budget_exhausted");
      expect(eventsOf(res, "run.created")[0].data.max_budget_usd).toBe(0.3);
    } finally {
      res.cleanup();
    }
  }, 150000);

  it("(e, f) no --max-budget-usd reaches claude's argv (planner or worker) when no cap is set; a set cap does", () => {
    const wrapDir = mkdtempSync(join(tmpdir(), "substrate-limits-argv-"));
    const wrap = argvWrapper(wrapDir);
    const manifest = manifestFor("r_EEEEEEEEEEEE", ["T1"]);
    const spec = taskSpec("T1", "src/feature.txt");

    // No cap anywhere: the planner session (the first claude call) and the worker get no --max-budget-usd.
    const none = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(manifest, { "tasks/T1.md": spec }), workerCall("src/feature.txt", 0.01)] },
      settings: { backends: { claude: { bin: wrap.bin } } },
      args: ARGS,
      timeoutMs: 120000,
    });
    try {
      const argv = loggedArgv(wrap.log);
      expect(argv.length).toBeGreaterThanOrEqual(2);
      for (const a of argv) expect(a).not.toContain("--max-budget-usd");
    } finally {
      none.cleanup();
    }

    // A run cap set on the command line: the planner session is capped at it.
    const runCap = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(manifest, { "tasks/T1.md": spec }), workerCall("src/feature.txt", 0.01)] },
      settings: { backends: { claude: { bin: wrap.bin } } },
      args: [ARGS[0], "--max-budget-usd", "3", ...ARGS.slice(1)],
      timeoutMs: 120000,
    });
    try {
      const argv = loggedArgv(wrap.log).slice(2);
      const capped = argv.filter((a) => a.includes("--max-budget-usd"));
      expect(capped.length).toBeGreaterThanOrEqual(1);
      expect(capped[0][capped[0].indexOf("--max-budget-usd") + 1]).toBe("3");
    } finally {
      runCap.cleanup();
    }

    // A task cap set in settings reaches the worker's argv.
    const taskCap = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(manifest, { "tasks/T1.md": spec }), workerCall("src/feature.txt", 0.01)] },
      settings: { backends: { claude: { bin: wrap.bin } }, budgets: { task: { max_usd: 0.1 } } },
      args: ARGS,
      timeoutMs: 120000,
    });
    try {
      const withCap = loggedArgv(wrap.log).filter((a) => a.includes("--max-budget-usd") && a[a.indexOf("--max-budget-usd") + 1] === "0.1");
      expect(withCap.length).toBeGreaterThanOrEqual(1);
    } finally {
      taskCap.cleanup();
      rmSync(wrapDir, { recursive: true, force: true });
    }
  }, 400000);

  it("(g) status shows budget: none in text and budget_usd: null in json for a no-limit run", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(manifestFor("r_GGGGGGGGGGGG", ["T1"]), { "tasks/T1.md": taskSpec("T1", "src/feature.txt") }), workerCall("src/feature.txt", 0.01)] },
      args: ARGS,
      timeoutMs: 120000,
    });
    try {
      expect(res.exitCode).toBe(0);
      const runId = basename(res.runDir as string);
      const text = spawnSync(process.execPath, [substrateMjs, "status", runId], { cwd: res.repoDir, encoding: "utf8", timeout: 120000 });
      expect(text.stdout).toContain("budget: none");
      expect(text.stdout).not.toContain("budget $");
      const json = spawnSync(process.execPath, [substrateMjs, "status", "--output-format", "json", runId], { cwd: res.repoDir, encoding: "utf8", timeout: 120000 });
      expect(JSON.parse(json.stdout).budget_usd).toBeNull();
    } finally {
      res.cleanup();
    }
  }, 150000);

  it("(h) resuming a no-limit planned run keeps it no-limit", () => {
    const repo = createE2ERepo(SEED);
    try {
      const planned = runSubstrate({
        repo,
        scenario: { calls: [planCall(manifestFor("r_HHHHHHHHHHHH", ["T1"]), { "tasks/T1.md": taskSpec("T1", "src/feature.txt") })] },
        args: ["run", "--permission-mode", "plan", "Plan with no limits"],
        timeoutMs: 120000,
      });
      expect(planned.exitCode).toBe(0);
      const runId = basename(planned.runDir as string);

      const resumed = runSubstrate({
        repo,
        scenario: { calls: [workerCall("src/feature.txt", 0.01)] },
        args: ["resume", runId],
        timeoutMs: 120000,
      });
      expect(resumed.exitCode, `${resumed.stdout.slice(-600)}\n${resumed.stderr.slice(-400)}`).toBe(0);
      const resumeEvents = [...eventsOf(resumed, "run.resumed"), ...eventsOf(resumed, "run.reopened")];
      expect(resumeEvents.length).toBeGreaterThan(0);
      expect(resumeEvents.at(-1)?.data.max_budget_usd).toBeNull();
      const json = spawnSync(process.execPath, [substrateMjs, "status", "--output-format", "json", runId], { cwd: repo.dir, encoding: "utf8", timeout: 120000 });
      expect(JSON.parse(json.stdout).budget_usd).toBeNull();
      resumed.cleanup();
      planned.cleanup();
    } finally {
      repo.cleanup();
    }
  }, 300000);

  it("(i) the lint: L016 is silent with no per-task cap and a warning (not an error) when a cap is set and a spec's estimate is above it", () => {
    const manifest = manifestFor("r_JJJJJJJJJJJJ", ["T1"]);
    const spec = taskSpec("T1", "src/feature.txt", ["  max_usd: 0.5"]);
    const planOnly = (settings?: Record<string, unknown>) =>
      runSubstrate({
        files: SEED,
        scenario: { calls: [planCall(manifest, { "tasks/T1.md": spec })] },
        ...(settings ? { settings } : {}),
        args: ["run", "--permission-mode", "plan", "Lint the limits case"],
        timeoutMs: 120000,
      });

    const none = planOnly();
    try {
      const lint = eventsOf(none, "plan.lint").at(-1)?.data as { diagnostics?: Array<{ code: string }> } | undefined;
      expect((lint?.diagnostics ?? []).filter((d) => d.code === "L016")).toEqual([]);
    } finally {
      none.cleanup();
    }

    const capped = planOnly({ budgets: { task: { max_usd: 0.1 } } });
    try {
      const lint = eventsOf(capped, "plan.lint").at(-1)?.data as { diagnostics?: Array<{ code: string; severity: string }> } | undefined;
      const l16 = (lint?.diagnostics ?? []).filter((d) => d.code === "L016");
      expect(l16).toHaveLength(1);
      expect(l16[0].severity).toBe("warn");
    } finally {
      capped.cleanup();
    }
  }, 300000);

  it("(j) the planner request renders the caps as no limit, or as the dollar cap when one is set", () => {
    const manifest = manifestFor("r_KKKKKKKKKKKK", ["T1"]);
    const spec = taskSpec("T1", "src/feature.txt");
    const capped = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(manifest, { "tasks/T1.md": spec })] },
      settings: { budgets: { task: { max_usd: 0.1 }, run: { max_usd: 4 } } },
      args: ["run", "--permission-mode", "plan", "Render the capped request"],
      timeoutMs: 120000,
    });
    try {
      const text = readFileSync(join(capped.runDir as string, "planner-request.md"), "utf8");
      expect(text).toContain("per-task cap: $0.10");
      expect(text).toContain("run cap: $4.00");
    } finally {
      capped.cleanup();
    }
  }, 150000);
});
