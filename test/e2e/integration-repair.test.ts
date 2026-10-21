import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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
});
