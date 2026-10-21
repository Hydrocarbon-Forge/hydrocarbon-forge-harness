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
// final verify is the only integration verify. A check that cannot run is a warning, and a
// single-task plan is not verified again. Built CLI, fake harnesses, scratch git repos.

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");

/** The plan's checks as shell commands; the setup creates the gitignored tooling file. */
interface Plan {
  setup: string;
  integration: string;
  tasks: string[];
  /** Seconds the integration command may run; the default is 60. */
  integrationTimeout?: number;
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
    ...step(`echo x >> ${s.verifyLog} && ${plan.integration}`, plan.integrationTimeout ?? 60),
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

/** The run's outcome as it is written to result.json (the object --output-format json prints). */
function resultOf(s: Scratch, runId: string): { verification?: string; verification_note?: string; exit_code: number } {
  return JSON.parse(readFileSync(join(s.project, ".substrate", "runs", runId, "result.json"), "utf8"));
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

describe("R12.2: a final check that cannot run is a warning; the work still merges", () => {
  it("a setup that fails in the integration worktree lands the work with a warning, verification not_run, and exit 0", () => {
    const s = scratch();
    try {
      // The setup fails only where the integration worktree is (its path ends in /integration).
      const plan: Plan = {
        setup: `touch .tooling-ready && echo $PWD >> ${s.setupLog} && case $PWD in */integration) exit 3 ;; esac`,
        integration: "test -f .tooling-ready",
        tasks: ["T1", "T2"],
      };
      prepare(s, plan);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("setup failed: ");
      expect(res.stdout, diag(res)).toContain("warning: integration verify could not run (");
      expect(res.stdout, diag(res)).toContain("the work is merged but was not verified as a whole");
      expect(res.stdout, diag(res)).toContain("Verification: not run (its setup failed (exit 3))\n");
      expect(res.stdout, diag(res)).toContain("Merged:     yes\n");
      expect(res.stdout, diag(res)).not.toContain("integration verify started");
      expect(readFileSync(join(s.project, "src", "a.txt"), "utf8")).toBe("a\n");
      const events = runEvents(s, runIdOf(res));
      expect(events.map((e) => e.type)).toContain("integration.could_not_run");
      expect(events.map((e) => e.type)).not.toContain("integration.failed");
      expect(events.filter((e) => e.type === "integration.setup.finished").map((e) => e.data)).toEqual([
        { passed: false, command: plan.setup, exit_code: 3 },
      ]);
      expect(resultOf(s, runIdOf(res)).verification).toBe("not_run");
      expect(resultOf(s, runIdOf(res)).verification_note).toBe("its setup failed (exit 3)");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["the command is not found (exit 127)", "definitely-missing-r122-tool --check", "the command was not found (exit 127)"],
    [
      "the tsc stub package answers (the R12.2 evidence)",
      `sh -c 'echo "This is not the tsc command you are looking for" >&2; echo "Use yarn to avoid accidentally running code from un-installed packages" >&2; exit 1'`,
      "tsc is not installed",
    ],
  ])("a final check where %s is a warning, not a failed run", (_label, integration, reason) => {
    const plan: Plan = { setup: "", integration, tasks: ["T1", "T2"] };
    const s = scratch();
    plan.setup = installingSetup(s);
    try {
      prepare(s, plan);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain(`(${reason})`);
      expect(res.stdout, diag(res)).toContain(`Verification: not run (${reason})\n`);
      expect(res.stdout, diag(res)).toContain("Merged:     yes\n");
      expect(existsSync(join(s.project, "src", "b.txt"))).toBe(true);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("a check that times out is a warning with no verdict; the work merges", () => {
    const s = scratch();
    try {
      const plan: Plan = { setup: installingSetup(s), integration: "sleep 30", tasks: ["T1", "T2"], integrationTimeout: 1 };
      prepare(s, plan);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("Verification: not run (timed out, so no verdict was produced)\n");
      expect(res.stdout, diag(res)).toContain("Merged:     yes\n");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("R12.2: a real failure of the final check still fails the run", () => {
  it("an assertion that fails exits 1 with verification failed in the json result, and names the command", () => {
    const failing = "test -f src/never.txt";
    const plan: Plan = { setup: "", integration: failing, tasks: ["T1", "T2"] };
    const s = scratch();
    plan.setup = installingSetup(s);
    try {
      prepare(s, plan);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(1);
      expect(res.stdout, diag(res)).toContain(`Reason:     integration_failed: echo x >> ${s.verifyLog} && ${failing} exited 1\n`);
      expect(res.stdout, diag(res)).not.toContain("Verification: not run");
      expect(resultOf(s, runIdOf(res)).verification).toBe("failed");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("R12.2: a single-task plan skips the final verify", () => {
  it("one task: integration.skipped once, no integration verify, the progress line, and verification skipped in json", () => {
    const s = scratch();
    try {
      const plan: Plan = { setup: installingSetup(s), integration: "test -f .tooling-ready", tasks: ["T1"] };
      prepare(s, plan);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toContain("integration verify skipped (single task: its own checks already ran)\n");
      const events = runEvents(s, runIdOf(res));
      expect(events.filter((e) => e.type === "integration.skipped").map((e) => e.data)).toEqual([{ reason: "single_task" }]);
      expect(events.map((e) => e.type)).not.toContain("integration.started");
      expect(linesOf(s.verifyLog)).toHaveLength(0);
      expect(linesOf(s.setupLog).filter((l) => l.endsWith("/integration"))).toHaveLength(0);
      expect(readFileSync(join(s.project, "src", "a.txt"), "utf8")).toBe("a\n");
      expect(resultOf(s, runIdOf(res)).verification).toBe("skipped");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("R12.2: a failed final check says what failed and shows the tail of its output", () => {
  it("the summary names the integration check, keeps Reason to one line, prints the last ten output lines, and json carries output_tail", () => {
    // Thirteen output lines: the summary shows the last ten (lines 4 to 12 and the assertion).
    const integration = `sh -c 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "line $i"; done; echo "AssertionError: expected 1 to be 2"; exit 1'`;
    const s = scratch();
    try {
      const plan: Plan = { setup: installingSetup(s), integration, tasks: ["T1", "T2"] };
      prepare(s, plan);
      const res = cli(s, RUN_ARGS);
      expect(res.status, diag(res)).toBe(1);
      expect(res.stdout, diag(res)).toContain(
        "NOT merged: the integration check failed (see Reason); the 2 tasks passed their own checks and stay on branch substrate/runs/",
      );
      expect(res.stdout, diag(res)).not.toContain("tasks failed or were skipped");
      const reasonLines = res.stdout.split("\n").filter((line) => line.startsWith("Reason:"));
      expect(reasonLines, diag(res)).toHaveLength(1);
      expect(reasonLines[0]).toMatch(/^Reason:     integration_failed: .* exited 1$/);
      expect(res.stdout, diag(res)).toContain("Output:\n  line 4\n");
      expect(res.stdout, diag(res)).toContain("  line 12\n  AssertionError: expected 1 to be 2\n");
      expect(res.stdout, diag(res)).not.toContain("  line 3\n");
      const result = resultOf(s, runIdOf(res)) as { output_tail?: string; failure_class?: string };
      expect(result.failure_class).toBe("integration_failed");
      expect(result.output_tail, diag(res)).toContain("AssertionError: expected 1 to be 2");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});
