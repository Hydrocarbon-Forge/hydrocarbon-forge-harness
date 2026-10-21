import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { contractFiles, planCall, taskSpec } from "./helpers/plan-scenario.js";
import { setUpWorktree } from "../../src/git/setup.js";

// R12.2: the plan's setup runs in the integration worktree before the final verify, once per
// worktree, and `merge --partial` runs it in its verify worktree. The base check is gone: the
// final verify is the only integration verify. Built CLI, fake harnesses, scratch git repos.

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");

/** The plan's checks as shell commands; the setup creates the gitignored tooling file. */
interface Plan {
  setup: string;
  integration: string;
  tasks: string[];
}

interface Scratch {
  root: string;
  project: string;
  /** One line per setup run: the worktree it ran in (the last path segment names it). */
  setupLog: string;
  /** One line per integration_verify run. */
  verifyLog: string;
  env: Record<string, string>;
}

function scratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-r122-setup-"));
  const project = join(root, "project");
  mkdirSync(project);
  return {
    root,
    project,
    setupLog: join(root, "setup.log"),
    verifyLog: join(root, "verify.log"),
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
      HOME: join(root, "home"),
      SUBSTRATE_CONFIG_DIR: join(root, "config"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "init.defaultBranch",
      GIT_CONFIG_VALUE_0: "main",
      GIT_AUTHOR_NAME: "R122 Test",
      GIT_AUTHOR_EMAIL: "r122@example.com",
      GIT_COMMITTER_NAME: "R122 Test",
      GIT_COMMITTER_EMAIL: "r122@example.com",
    },
  };
}

/** The setup that installs the tooling file and records the worktree it ran in. */
function installingSetup(s: Scratch): string {
  return `touch .tooling-ready && echo $PWD >> ${s.setupLog}`;
}

function manifestYaml(s: Scratch, plan: Plan): string {
  const step = (run: string, timeout = 60): string[] => [`  - run: ${JSON.stringify(run)}`, `    timeout_s: ${timeout}`];
  return [
    "version: 1",
    "run_id: r_SETUPRUNABCD",
    "goal: Two files with a tooling check",
    "base_ref: main",
    "ecosystem: other",
    "setup:",
    ...step(plan.setup),
    "contracts:",
    "  files:",
    "    - contracts/types.ts",
    "  typecheck:",
    "    - run: echo typecheck contracts",
    "      timeout_s: 30",
    "integration_verify:",
    ...step(`echo x >> ${s.verifyLog} && ${plan.integration}`),
    "tasks:",
    ...plan.tasks.flatMap((id) => [`  - id: ${id}`, `    spec: tasks/${id}.md`]),
    "",
  ].join("\n");
}

/**
 * Writes the plan, the scenario and the project's git repo (its .gitignore lists the tooling
 * file). T1 writes src/a.txt; T2 writes src/b.txt unless `t2Fails` is set (then it never writes).
 */
function prepare(s: Scratch, plan: Plan, extraCalls: unknown[] = []): void {
  const taskSpecs: Record<string, string> = {
    "tasks/T1.md": taskSpec({ id: "T1", write: [], create: ["src/a.txt"], verify: "grep -q a src/a.txt" }),
    "tasks/T2.md": taskSpec({ id: "T2", write: [], create: ["src/b.txt"], verify: "grep -q b src/b.txt" }),
  };
  const taskFiles = Object.fromEntries(plan.tasks.map((id) => [`tasks/${id}.md`, taskSpecs[`tasks/${id}.md`]]));
  const calls: unknown[] = [
    planCall(contractFiles(manifestYaml(s, plan), taskFiles)),
    { task: "T1", edits: { "src/a.txt": "a\n" }, reply: "T1 done\nDONE" },
    ...(plan.tasks.includes("T2") && !extraCalls.length ? [{ task: "T2", edits: { "src/b.txt": "b\n" }, reply: "T2 done\nDONE" }] : []),
    ...extraCalls,
  ];
  const scenario = join(s.root, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ calls }), "utf8");
  s.env.FAKE_SCENARIO_FILE = scenario;
  writeFileSync(join(s.project, ".gitignore"), ".tooling-ready\n", "utf8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: s.project, env: s.env });
  execFileSync("git", ["add", ".gitignore"], { cwd: s.project, env: s.env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: s.project, env: s.env });
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

function git(s: Scratch, args: string[]): string {
  return execFileSync("git", args, { cwd: s.project, encoding: "utf8", env: s.env }).trim();
}

function diag(res: { status: number | null; stdout: string; stderr: string }): string {
  return `exit=${res.status}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

function runEvents(s: Scratch, runId: string): { type: string; data: any }[] {
  return readFileSync(join(s.project, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function linesOf(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function runIdOf(res: { stdout: string }): string {
  return /Run ID:\s+(\S+)/.exec(res.stdout)?.[1] ?? "";
}

const RUN_ARGS = [
  "run",
  "--plan", "claude:claude-sonnet-5-5",
  "--work", "claude:haiku",
  "--merge",
  "--permission-mode", "bypassPermissions",
  "Two files with a tooling check",
];

const TWO_TASKS = (s: Scratch): Plan => ({
  setup: installingSetup(s),
  integration: "test -f .tooling-ready",
  tasks: ["T1", "T2"],
});

describe("R12.2: the plan's setup runs in the integration worktree before the final verify", () => {
  it("a two-task plan whose check needs the setup's file passes; the setup ran once in the integration worktree", () => {
    const s = scratch();
    try {
      prepare(s, TWO_TASKS(s));
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("integration verify passed\n");
      expect(res.stdout, diag(res)).toContain("setup done\n");
      const types = runEvents(s, runIdOf(res)).map((e) => e.type);
      expect(types).toContain("integration.setup.started");
      expect(types).toContain("integration.setup.finished");
      expect(types).not.toContain("integration.failed");
      // Each task worktree ran the setup, and the integration worktree ran it once.
      expect(linesOf(s.setupLog).filter((l) => l.endsWith("/integration")), diag(res)).toHaveLength(1);
      expect(git(s, ["branch", "--show-current"])).toBe("main");
      expect(readFileSync(join(s.project, "src", "a.txt"), "utf8")).toBe("a\n");
      expect(readFileSync(join(s.project, "src", "b.txt"), "utf8")).toBe("b\n");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("R12.2: the base check is gone", () => {
  it("integration_verify runs once for a passing run; no base note, and no base field in the new events", () => {
    const s = scratch();
    try {
      prepare(s, TWO_TASKS(s));
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(linesOf(s.verifyLog), diag(res)).toHaveLength(1);
      expect(res.stdout, diag(res)).not.toMatch(/base/);
      const events = runEvents(s, runIdOf(res));
      expect(events.filter((e) => e.type === "integration.started").map((e) => e.data)).toEqual([{}]);
      expect(JSON.stringify(events)).not.toContain("base_verify_passed");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("R12.2: setUpWorktree runs the setup once per worktree", () => {
  it("a second call on the same worktree runs nothing; a worktree created again runs the setup again", async () => {
    const root = mkdtempSync(join(tmpdir(), "substrate-r122-once-"));
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      const env = {
        ...(process.env as Record<string, string>),
        GIT_AUTHOR_NAME: "R122 Test",
        GIT_AUTHOR_EMAIL: "r122@example.com",
        GIT_COMMITTER_NAME: "R122 Test",
        GIT_COMMITTER_EMAIL: "r122@example.com",
      };
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
      writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
      execFileSync("git", ["add", "f.txt"], { cwd: repo, env });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, env });
      const log = join(root, "count.log");
      const commands = [{ run: `echo ran >> ${log}`, timeout_s: 30 }];
      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "--detach", wt, "main"], { cwd: repo, env });
      expect(await setUpWorktree(wt, commands)).toEqual({ passed: true, ran: 1 });
      expect(await setUpWorktree(wt, commands)).toBeUndefined();
      expect(linesOf(log)).toHaveLength(1);
      // A worktree removed and created again has no marker: its setup runs again.
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, env });
      execFileSync("git", ["worktree", "add", "--detach", wt, "main"], { cwd: repo, env });
      expect(await setUpWorktree(wt, commands)).toEqual({ passed: true, ran: 1 });
      expect(linesOf(log)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R12.2: merge --partial runs the setup in its verify worktree", () => {
  it("a failed run with one passed task lands it once the setup and the check pass in the verify worktree", () => {
    const s = scratch();
    try {
      // T2 never writes its file: its own check fails, so the run fails with T1 merged on the run branch.
      prepare(s, TWO_TASKS(s), [
        { task: "T2", reply: "gave up\nDONE" },
        { task: "T2", reply: "gave up\nDONE" },
        { task: "T2", reply: "gave up\nDONE" },
        { task: "T2", reply: "gave up\nDONE" },
      ]);
      const run = cli(s, RUN_ARGS);
      expect(run.status, diag(run)).toBe(1);
      const runId = runIdOf(run);
      expect(runEvents(s, runId).map((e) => e.type)).toContain("task.merged");
      expect(existsSync(join(s.project, "src", "a.txt"))).toBe(false);
      const partial = spawnSync(process.execPath, [CLI, "merge", runId, "--partial"], {
        cwd: s.project,
        encoding: "utf8",
        env: s.env,
        timeout: 300000,
      });
      expect(partial.status, diag(partial)).toBe(0);
      expect(linesOf(s.setupLog).filter((l) => l.endsWith("/partial-verify"))).toHaveLength(1);
      expect(readFileSync(join(s.project, "src", "a.txt"), "utf8")).toBe("a\n");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});
