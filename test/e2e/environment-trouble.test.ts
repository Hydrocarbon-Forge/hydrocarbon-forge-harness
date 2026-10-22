import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { contractFiles, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R13.1: environment trouble is a warning or a retry, never a failed run. A plan's setup that fails in a task
// worktree is a warning: the worker still runs, its prompt says what failed, and the run finishes. Built CLI,
// fake harnesses, scratch git repos.

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");

/** The setup command that cannot succeed: the file it checks for is never created. */
const FAILING_SETUP = "test -f .tooling-ready";

/** The text the setup-failed prompt fragment carries (assets/prompts/worker/setup-failed.md). */
const SETUP_NOTE = "Setup failed before you started";

interface Scratch {
  root: string;
  project: string;
  scenario: string;
  env: Record<string, string>;
}

function scratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-r131-env-"));
  const project = join(root, "project");
  mkdirSync(project);
  const scenario = join(root, "scenario.json");
  return {
    root,
    project,
    scenario,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
      HOME: join(root, "home"),
      SUBSTRATE_CONFIG_DIR: join(root, "config"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "init.defaultBranch",
      GIT_CONFIG_VALUE_0: "main",
      GIT_AUTHOR_NAME: "R131 Test",
      GIT_AUTHOR_EMAIL: "r131@example.com",
      GIT_COMMITTER_NAME: "R131 Test",
      GIT_COMMITTER_EMAIL: "r131@example.com",
    },
  };
}

function manifestYaml(): string {
  return [
    "version: 1",
    "run_id: r_ENVTRBLEABC2",
    "goal: One file, a setup that cannot succeed",
    "base_ref: main",
    "ecosystem: other",
    "setup:",
    `  - run: ${JSON.stringify(FAILING_SETUP)}`,
    "    timeout_s: 30",
    "contracts:",
    "  files:",
    "    - contracts/types.ts",
    "  typecheck:",
    "    - run: echo typecheck contracts",
    "      timeout_s: 30",
    "integration_verify:",
    "  - run: echo whole",
    "    timeout_s: 60",
    "tasks:",
    "  - id: T1",
    "    spec: tasks/T1.md",
    "",
  ].join("\n");
}

function prepare(s: Scratch): void {
  const specs = { "tasks/T1.md": taskSpec({ id: "T1", write: [], create: ["src/a.txt"], verify: "grep -q a src/a.txt" }) };
  const calls: unknown[] = [
    planCall(contractFiles(manifestYaml(), specs)),
    { task: "T1", edits: { "src/a.txt": "a\n" }, reply: "T1 done\nDONE" },
  ];
  writeFileSync(s.scenario, JSON.stringify({ calls }), "utf8");
  s.env.FAKE_SCENARIO_FILE = s.scenario;
  git(s, ["init", "-q", "-b", "main"]);
  writeFileSync(join(s.project, "README.md"), "project\n", "utf8");
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

function runEvents(s: Scratch, runId: string): { type: string; data: any }[] {
  return readFileSync(join(s.project, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("R13.1: environment trouble is a warning or a retry, never a failed run", () => {
  it("(1) a failing setup warns, the worker still runs with the failure in its prompt, and the run finishes", () => {
    const s = scratch();
    try {
      prepare(s);
      const res = cli(s, [
        "run",
        "--plan", "claude:claude-sonnet-5-5",
        "--work", "claude:haiku",
        "--merge",
        "--permission-mode", "bypassPermissions",
        "One file after a failing setup",
      ]);
      expect(res.status, diag(res)).toBe(0);
      expect(`${res.stdout}${res.stderr}`, diag(res)).toContain("warning: setup failed");

      const runId = /Run ID:\s+(\S+)/.exec(res.stdout)?.[1] ?? "";
      const events = runEvents(s, runId);
      expect(events.find((e) => e.type === "task.setup.failed")?.data).toMatchObject({
        task_id: "T1",
        command: FAILING_SETUP,
        reason: "exit 1",
      });
      expect(events.some((e) => e.type === "task.failed")).toBe(false);
      expect(events.find((e) => e.type === "task.merged")).toBeDefined();

      // The worker's own prompt (the fake logs it as the last argv entry) carries the setup note.
      const workerPrompts = readFileSync(`${s.scenario}.argv.jsonl`, "utf8")
        .split("\n")
        .filter((l) => l.includes(SETUP_NOTE));
      expect(workerPrompts.length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(join(s.project, ".substrate", "runs", runId, "result.json"), "utf8"))).toMatchObject({
        exit_code: 0,
      });
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});
