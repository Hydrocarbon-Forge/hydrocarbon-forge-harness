import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R7.11: an integration verify that fails on the base commit no longer fails the run. The
// greenfield plan below checks a file that only the task creates, so the check fails at base,
// the run goes on, and the verify on the merged result passes. Built CLI, fake harnesses.

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");
const INTEGRATION = "sh -c 'test -f src/hello.txt'";

function helloCalls(integrationCmd: string): unknown[] {
  return [
    planCall(
      contractFiles(manifestFor("Create the hello file", ["T1"], integrationCmd), {
        "tasks/T1.md": taskSpec({ id: "T1", write: [], create: ["src/hello.txt"], verify: "grep -q hello src/hello.txt" }),
      }),
    ),
    { edits: { "src/hello.txt": "hello\n" }, reply: "T1 done\nDONE" },
  ];
}

interface Scratch {
  root: string;
  project: string;
  env: Record<string, string>;
}

function scratch(calls: unknown[]): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-r711-base-"));
  const project = join(root, "project");
  mkdirSync(project);
  const scenario = join(root, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ calls }), "utf8");
  return {
    root,
    project,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
      HOME: join(root, "home"),
      SUBSTRATE_CONFIG_DIR: join(root, "config"),
      FAKE_SCENARIO_FILE: scenario,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "init.defaultBranch",
      GIT_CONFIG_VALUE_0: "main",
      GIT_AUTHOR_NAME: "R711 Test",
      GIT_AUTHOR_EMAIL: "r711@example.com",
      GIT_COMMITTER_NAME: "R711 Test",
      GIT_COMMITTER_EMAIL: "r711@example.com",
    },
  };
}

function cli(s: Scratch, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: s.project,
    input: "",
    encoding: "utf8",
    env: s.env,
    timeout: 120000,
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

const BASE_NOTE =
  "note: integration verify did not pass before this run's changes (normal when the run adds code); this is not a failure";

describe("R7.11: integration verify on the base commit and on the merged result", () => {
  it("the run lands with --merge, the file is in the working tree, and no base note is printed when the final verify passes", () => {
    const s = scratch(helloCalls(INTEGRATION));
    try {
      const res = cli(s, [
        "run",
        "--plan", "claude:claude-sonnet-5-5",
        "--work", "claude:haiku",
        "--merge",
        "--permission-mode", "bypassPermissions",
        "Create the hello file",
      ]);
      expect(res.status, diag(res)).toBe(0);
      // R11.3: the base check failed, but the final verify passed, so the note (which says the check failed before the run) is not printed.
      expect(res.stdout, diag(res)).not.toContain(BASE_NOTE);
      expect(res.stdout, diag(res)).toContain("integration verify passed\n");
      expect(readFileSync(join(s.project, "src", "hello.txt"), "utf8")).toBe("hello\n");
      expect(git(s, ["branch", "--show-current"])).toBe("main");
      const runId = /Run ID:\s+(\S+)/.exec(res.stdout)?.[1];
      expect(runId, diag(res)).toBeDefined();
      const started = runEvents(s, runId!).find((e) => e.type === "integration.started");
      expect(started?.data).toEqual({ base_verify_passed: false });
      expect(runEvents(s, runId!).map((e) => e.type)).not.toContain("integration.failed");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("a verify that fails on the merged result still stops the run, and says which command failed, with its exit code", () => {
    const failing = "sh -c 'test -f src/never.txt'";
    const s = scratch(helloCalls(failing));
    try {
      const res = cli(s, [
        "run",
        "--plan", "claude:claude-sonnet-5-5",
        "--work", "claude:haiku",
        "--merge",
        "--permission-mode", "bypassPermissions",
        "Create the hello file",
      ]);
      // The batch verify and the culprit bisect run the same command on the same tree, so the
      // culprit (T1) carries the failure. No question is asked, so the run fails with exit 1
      // and its reason names the command (R8.1); it no longer pauses for needs_human.
      expect(res.status, diag(res)).toBe(1);
      expect(res.stdout, diag(res)).toContain(`[task T1] failed: integration_failed: ${failing} exited 1\n`);
      expect(res.stdout, diag(res)).toContain(`Reason:     integration_failed: ${failing} exited 1\n`);
      expect(res.stdout, diag(res)).toContain("Status:     failed\n");
      expect(res.stdout, diag(res)).not.toContain("Merged:     yes");
      expect(existsSync(join(s.project, "src", "hello.txt"))).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("the json result of that run names the failure class and the command in its message", () => {
    const failing = "sh -c 'test -f src/never.txt'";
    const s = scratch(helloCalls(failing));
    try {
      const res = cli(s, [
        "run",
        "--plan", "claude:claude-sonnet-5-5",
        "--work", "claude:haiku",
        "--merge",
        "--output-format", "json",
        "--permission-mode", "bypassPermissions",
        "Create the hello file",
      ]);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.failure_class, diag(res)).toBe("integration_failed");
      expect(summary.message, diag(res)).toBe(`${failing} exited 1`);
      expect(summary.merged, diag(res)).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});
