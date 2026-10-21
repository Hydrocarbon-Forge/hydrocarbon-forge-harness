import { describe, it, expect } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { contractFiles, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R12.4: a failed final integration check gets up to `integration.repair_attempts` automatic code repairs.
// Each task passes its own verify; the whole-project check fails until a repair adds the marker. Built CLI,
// fake harnesses, scratch git repos. Every case reads the repair worker spawns from the fake harness's argv log.

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");

/** The marker a repair adds: the whole-project check greps for it. */
const CHECK = "grep -q repaired src/a.txt";

/** The text every repair prompt carries (assets/prompts/worker/repair.md). */
const REPAIR_PROMPT = "The whole-project check of this run failed";

interface Scratch {
  root: string;
  project: string;
  scenario: string;
  argvLog: string;
  verifyLog: string;
  env: Record<string, string>;
}

function scratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-r124-repair-"));
  const project = join(root, "project");
  mkdirSync(project);
  const scenario = join(root, "scenario.json");
  return {
    root,
    project,
    scenario,
    argvLog: `${scenario}.argv.jsonl`,
    verifyLog: join(root, "verify.log"),
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
      HOME: join(root, "home"),
      SUBSTRATE_CONFIG_DIR: join(root, "config"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "init.defaultBranch",
      GIT_CONFIG_VALUE_0: "main",
      GIT_AUTHOR_NAME: "R124 Test",
      GIT_AUTHOR_EMAIL: "r124@example.com",
      GIT_COMMITTER_NAME: "R124 Test",
      GIT_COMMITTER_EMAIL: "r124@example.com",
    },
  };
}

interface Plan {
  tasks: string[];
  /** The whole-project check, run as one shell line. */
  integration: string;
}

function manifestYaml(s: Scratch, plan: Plan): string {
  return [
    "version: 1",
    "run_id: r_REPAIRRUNABC",
    "goal: Two files and a whole-project check",
    "base_ref: main",
    "ecosystem: other",
    "setup:",
    `  - run: "true"`,
    "    timeout_s: 30",
    "contracts:",
    "  files:",
    "    - contracts/types.ts",
    "  typecheck:",
    "    - run: echo typecheck contracts",
    "      timeout_s: 30",
    "integration_verify:",
    `  - run: ${JSON.stringify(`echo x >> ${s.verifyLog} && ${plan.integration}`)}`,
    "    timeout_s: 60",
    "tasks:",
    ...plan.tasks.flatMap((id) => [`  - id: ${id}`, `    spec: tasks/${id}.md`]),
    "",
  ].join("\n");
}

/** Writes the plan and the scenario, and inits a repo that holds a test file the repairs may try to delete. */
function prepare(s: Scratch, plan: Plan, repairCalls: unknown[]): void {
  const taskFiles: Record<string, string> = {
    "tasks/T1.md": taskSpec({ id: "T1", write: [], create: ["src/a.txt"], verify: "grep -q a src/a.txt" }),
    "tasks/T2.md": taskSpec({ id: "T2", write: [], create: ["src/b.txt"], verify: "grep -q b src/b.txt" }),
  };
  const specs = Object.fromEntries(plan.tasks.map((id) => [`tasks/${id}.md`, taskFiles[`tasks/${id}.md`]]));
  const calls: unknown[] = [
    planCall(contractFiles(manifestYaml(s, plan), specs)),
    { task: "T1", edits: { "src/a.txt": "a\n" }, reply: "T1 done\nDONE" },
    ...(plan.tasks.includes("T2") ? [{ task: "T2", edits: { "src/b.txt": "b\n" }, reply: "T2 done\nDONE" }] : []),
    ...repairCalls,
  ];
  writeFileSync(s.scenario, JSON.stringify({ calls }), "utf8");
  s.env.FAKE_SCENARIO_FILE = s.scenario;
  mkdirSync(join(s.project, "test"));
  writeFileSync(join(s.project, "test", "a.test.ts"), "test('a', () => {});\n", "utf8");
  writeFileSync(join(s.project, ".gitignore"), ".tooling-ready\n", "utf8");
  git(s, ["init", "-q", "-b", "main"]);
  git(s, ["add", "."]);
  git(s, ["commit", "-q", "-m", "init"]);
}

/** Appends repair calls to the scenario: the fake harness consumes them in order, per task id. */
function addCalls(s: Scratch, calls: unknown[]): void {
  const scenario = JSON.parse(readFileSync(s.scenario, "utf8")) as { calls: unknown[] };
  scenario.calls.push(...calls);
  writeFileSync(s.scenario, JSON.stringify(scenario), "utf8");
}

function git(s: Scratch, args: string[]): string {
  return execFileSync("git", args, { cwd: s.project, encoding: "utf8", env: s.env }).trim();
}

function cli(s: Scratch, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: s.project,
    input: "",
    encoding: "utf8",
    env: s.env,
    timeout: 300000,
  });
}

function diag(res: { status: number | null; stdout: string; stderr: string }): string {
  return `exit=${res.status}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

function runIdOf(res: { stdout: string }): string {
  return /Run ID:\s+(\S+)/.exec(res.stdout)?.[1] ?? "";
}

function runEvents(s: Scratch, runId: string): { type: string; data: any }[] {
  return readFileSync(join(s.project, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/** The number of repair worker spawns the fake harness served (one argv line per invocation). */
function repairSpawns(s: Scratch): number {
  if (!existsSync(s.argvLog)) return 0;
  return readFileSync(s.argvLog, "utf8").split("\n").filter((l) => l.includes(REPAIR_PROMPT)).length;
}

function resultOf(s: Scratch, runId: string): { exit_code: number; repaired?: number; repair?: { passed: boolean; attempts: number } } {
  return JSON.parse(readFileSync(join(s.project, ".substrate", "runs", runId, "result.json"), "utf8"));
}

const RUN_ARGS = [
  "run",
  "--plan", "claude:claude-sonnet-5-5",
  "--work", "claude:haiku",
  "--merge",
  "--permission-mode", "bypassPermissions",
  "Two files and a whole-project check",
];

/** The repair edit that makes CHECK pass. */
const FIX = { edits: { "src/a.txt": "a\nrepaired\n" }, reply: "Added the marker.\nDONE" };

function taskPairs(): Plan {
  return { tasks: ["T1", "T2"], integration: CHECK };
}

describe("R12.4: a failed final check is repaired automatically", () => {
  it("(1) attempt 1 repairs: the run finishes, merges, exits 0, and the events are in order", () => {
    const s = scratch();
    try {
      prepare(s, taskPairs(), [{ task: "REPAIR-1", ...FIX }]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("integration check failed; repairing (attempt 1 of 2)");
      expect(res.stdout, diag(res)).toContain("integration verify passed after repair");
      expect(res.stdout, diag(res)).toContain("Repaired:   integration check passed after 1 repair attempt");
      expect(repairSpawns(s)).toBe(1);
      const runId = runIdOf(res);
      const types = runEvents(s, runId).map((e) => e.type).filter((t) => t.startsWith("integration.") || t === "run.finished");
      const started = types.indexOf("integration.repair.started");
      const finished = types.indexOf("integration.repair.finished");
      const verified = types.lastIndexOf("integration.finished");
      expect(started).toBeGreaterThan(types.indexOf("integration.started"));
      expect(finished).toBeGreaterThan(started);
      expect(verified).toBeGreaterThan(finished);
      const events = runEvents(s, runId);
      expect(events.find((e) => e.type === "integration.repair.finished")?.data).toMatchObject({ task_id: "REPAIR-1", attempt: 1, passed: true });
      expect(events.find((e) => e.type === "integration.finished")?.data).toEqual({ passed: true, repaired: 1 });
      expect(resultOf(s, runId)).toMatchObject({ exit_code: 0, repaired: 1 });
      expect(readFileSync(join(s.project, "src", "a.txt"), "utf8")).toBe("a\nrepaired\n");
      // The repair attempt is a row of status, like a task's, with a shared status word.
      const status = cli(s, ["status", runId]);
      expect(status.stdout, diag(status)).toMatch(/REPAIR-1\s+passed/);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(2) attempt 1 deletes a test file (rejected by the guard); attempt 2 repairs: exits 0 with repaired: 2", () => {
    const s = scratch();
    try {
      prepare(s, taskPairs(), [
        { task: "REPAIR-1", remove: ["test/a.test.ts"], reply: "Removed the failing test.\nDONE" },
        { task: "REPAIR-2", ...FIX },
      ]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("repair attempt 1 rejected: it deletes test file test/a.test.ts");
      expect(repairSpawns(s)).toBe(2);
      const runId = runIdOf(res);
      expect(resultOf(s, runId)).toMatchObject({ exit_code: 0, repaired: 2 });
      expect(existsSync(join(s.project, "test", "a.test.ts")), diag(res)).toBe(true);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(2b) attempt 1 changes nothing (rejected); attempt 2 repairs: exits 0 with repaired: 2", () => {
    const s = scratch();
    try {
      prepare(s, taskPairs(), [
        { task: "REPAIR-1", reply: "I looked, nothing to do.\nDONE" },
        { task: "REPAIR-2", ...FIX },
      ]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("repair attempt 1 rejected: the repair changed nothing");
      expect(repairSpawns(s)).toBe(2);
      expect(resultOf(s, runIdOf(res))).toMatchObject({ exit_code: 0, repaired: 2 });
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(3) both attempts fail: exits 1, the run fails, the branch is kept, the summary says why, two spawns", () => {
    const s = scratch();
    try {
      const wrong = { edits: { "src/other.txt": "x\n" }, reply: "DONE" };
      prepare(s, taskPairs(), [
        { task: "REPAIR-1", ...wrong },
        { task: "REPAIR-2", ...wrong },
      ]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(1);
      expect(res.stdout, diag(res)).toMatch(/Status:\s+failed/);
      expect(res.stdout, diag(res)).toContain("Reason:     integration_failed:");
      expect(res.stdout, diag(res)).toContain(
        "Repair:     2 attempts, none passed (the integration check still fails in the repair worktree)",
      );
      expect(res.stdout, diag(res)).toContain("attempt 1: rejected: the integration check still fails in the repair worktree");
      expect(res.stdout, diag(res)).toContain("attempt 2: rejected: the integration check still fails in the repair worktree");
      expect(repairSpawns(s)).toBe(2);
      const branches = git(s, ["branch", "--list", "substrate/runs/*"]);
      expect(branches, diag(res)).toContain("substrate/runs/");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(3b) a repair that passes in its worktree but not after the merge: merged, re-run fails, both attempts used", () => {
    const s = scratch();
    try {
      // The check fails only in the integration worktree, so a repair passes in its own worktree and fails after
      // the merge. The merged repair stays on the run branch, as a merged task does (the run keeps its history).
      const onlyInRepair = "grep -q repaired src/a.txt && [ \"$(basename \"$PWD\")\" != integration ]";
      prepare(s, { tasks: ["T1", "T2"], integration: onlyInRepair }, [
        { task: "REPAIR-1", ...FIX },
        { task: "REPAIR-2", ...FIX },
      ]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(1);
      // Attempt 2 starts from the HEAD attempt 1 merged, which already holds the fix, so it changes nothing.
      expect(res.stdout, diag(res)).toContain(
        "Repair:     2 attempts, none passed (the repair changed nothing)",
      );
      expect(res.stdout, diag(res)).toContain("attempt 1: rejected: the integration check still fails after the repair was merged");
      expect(res.stdout, diag(res)).toContain("attempt 2: rejected: the repair changed nothing");
      expect(repairSpawns(s)).toBe(2);
      // The merged repair stays on the run branch, as a merged task's work does.
      const log = git(s, ["log", "--format=%s", "substrate/runs/" + runIdOf(res)]);
      expect(log, diag(res)).toContain("repair: integration check (attempt 1)");
      const events = runEvents(s, runIdOf(res));
      expect(events.filter((e) => e.type === "integration.repair.finished").map((e) => e.data.passed)).toEqual([false, false]);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(4) CHECK-UNFIXABLE: exactly one repair spawn, the run fails, and the reason is shown", () => {
    const s = scratch();
    try {
      prepare(s, taskPairs(), [
        { task: "REPAIR-1", reply: "The check needs a tool that is not installed here.\nCHECK-UNFIXABLE: the linter binary is missing" },
      ]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(1);
      expect(repairSpawns(s)).toBe(1);
      expect(res.stdout, diag(res)).toContain(
        "Repair:     1 attempt, none passed (CHECK-UNFIXABLE: the linter binary is missing)",
      );
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(5) a check that could not run is a warning: zero repair spawns, the run finishes with exit 0", () => {
    const s = scratch();
    try {
      prepare(s, { tasks: ["T1", "T2"], integration: "nonexistent-tool-r124 --check" }, [{ task: "REPAIR-1", ...FIX }]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("warning: integration verify could not run");
      expect(repairSpawns(s)).toBe(0);
      expect(runEvents(s, runIdOf(res)).some((e) => e.type === "integration.repair.started")).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(6) integration.repair_attempts 0: zero repair spawns, and the failed run fails as before", () => {
    const s = scratch();
    try {
      prepare(s, taskPairs(), [{ task: "REPAIR-1", ...FIX }]);
      mkdirSync(join(s.project, ".substrate"), { recursive: true });
      writeFileSync(join(s.project, ".substrate", "settings.json"), JSON.stringify({ integration: { repair_attempts: 0 } }), "utf8");
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(1);
      expect(repairSpawns(s)).toBe(0);
      expect(res.stdout, diag(res)).not.toContain("Repair:");
      expect(runEvents(s, runIdOf(res)).some((e) => e.type.startsWith("integration.repair"))).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(7) a single-task plan is not verified again, so no repair runs", () => {
    const s = scratch();
    try {
      prepare(s, { tasks: ["T1"], integration: CHECK }, [{ task: "REPAIR-1", ...FIX }]);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(repairSpawns(s)).toBe(0);
      expect(runEvents(s, runIdOf(res)).some((e) => e.type === "integration.skipped")).toBe(true);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("(8) SIGINT during a repair attempt: exit 130, the worker is gone; resume runs the check and a fresh repair", async () => {
    const s = scratch();
    try {
      prepare(s, taskPairs(), [{ task: "REPAIR-1", delay_ms: 120000, reply: "DONE" }]);
      const child = spawn(process.execPath, [CLI, ...RUN_ARGS], { cwd: s.project, env: s.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
      // Wait until the repair worker has been spawned, then interrupt the run.
      const deadline = Date.now() + 100000;
      while (repairSpawns(s) === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(repairSpawns(s)).toBe(1);
      child.kill("SIGINT");
      const code = await exited;
      expect(code, stdout).toBe(130);
      // No process of this run is left: the repair worker's session was stopped with the run (its command line
      // names the scratch directory the fake harness reads its scenario from).
      const living = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
      expect(living.split("\n").filter((l) => l.includes(s.root))).toEqual([]);
      const runId = /Run ID:\s+(\S+)/.exec(stdout)?.[1] ?? "";
      expect(runId).not.toBe("");

      addCalls(s, [{ task: "REPAIR-1", ...FIX }]);
      const res = cli(s, ["resume", runId, "--permission-mode", "bypassPermissions"]);
      expect(res.status, diag(res)).toBe(0);
      expect(repairSpawns(s)).toBe(2);
      expect(resultOf(s, runId)).toMatchObject({ exit_code: 0, repaired: 1 });
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }, 180000);

  it("(9) resume of a run whose repairs were exhausted gets a fresh set of attempts", () => {
    const s = scratch();
    try {
      const wrong = { edits: { "src/other.txt": "x\n" }, reply: "DONE" };
      prepare(s, taskPairs(), [
        { task: "REPAIR-1", ...wrong },
        { task: "REPAIR-2", ...wrong },
      ]);
      const first = cli(s, RUN_ARGS);
      expect(first.status, diag(first)).toBe(1);
      const runId = runIdOf(first);
      expect(repairSpawns(s)).toBe(2);

      addCalls(s, [{ task: "REPAIR-1", ...FIX }]);
      const res = cli(s, ["resume", runId, "--permission-mode", "bypassPermissions"]);
      expect(res.status, diag(res)).toBe(0);
      expect(repairSpawns(s)).toBe(3);
      expect(resultOf(s, runId)).toMatchObject({ exit_code: 0, repaired: 1 });
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});
