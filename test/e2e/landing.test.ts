import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R7.4: where a run's work lands. Each test starts from an empty directory (R7.2 initialises
// it), runs the built CLI against the fake harnesses and reads the working tree and the
// summary. The fake's scenario keeps its call index in the scenario file, so each run gets a file of its own.

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");
const HELLO_CALLS = (): unknown[] => [
  planCall(
    contractFiles(manifestFor("Create the hello file", ["T1"]), {
      "tasks/T1.md": taskSpec({ id: "T1", write: [], create: ["src/hello.txt"], verify: "grep -q hello src/hello.txt" }),
    }),
  ),
  { edits: { "src/hello.txt": "hello\n" }, reply: "T1 done\nDONE" },
];

interface Scratch {
  root: string;
  project: string;
  env: Record<string, string>;
}

function scratch(calls: unknown[]): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-r74-land-"));
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
      // The planner's manifest names base_ref main; a fresh repository gets that branch name.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "init.defaultBranch",
      GIT_CONFIG_VALUE_0: "main",
      GIT_AUTHOR_NAME: "R74 Test",
      GIT_AUTHOR_EMAIL: "r74@example.com",
      GIT_COMMITTER_NAME: "R74 Test",
      GIT_COMMITTER_EMAIL: "r74@example.com",
    },
  };
}

function cli(s: Scratch, args: string[], stdin = "") {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: s.project,
    input: stdin,
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

describe("R7.4: where the work lands", () => {
  it("greenfield with --plan, --work and --merge: the files are in the working tree and json says merged", () => {
    const s = scratch(HELLO_CALLS());
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
      expect(res.status, diag(res)).toBe(0);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.merged, diag(res)).toBe(true);
      expect(summary.base_branch).toBe("main");
      expect(summary.files_changed).toContain("src/hello.txt");
      expect(summary.files_changed_total).toBeGreaterThanOrEqual(1);
      expect(summary.next).toEqual([]);
      expect(git(s, ["branch", "--show-current"])).toBe("main");
      expect(readFileSync(join(s.project, "src", "hello.txt"), "utf8")).toBe("hello\n");
      expect(existsSync(join(s.project, "contracts", "types.ts"))).toBe(true);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  // R10.1: --no-merge is the opt-out; the run is then left on its branch and the printed command merges it.
  it("the same run with --no-merge leaves the files out of the working tree, and the printed command merges them", () => {
    const s = scratch(HELLO_CALLS());
    try {
      const res = cli(s, [
        "run",
        "--plan", "claude:claude-sonnet-5-5",
        "--work", "claude:haiku",
        "--no-merge",
        "--permission-mode", "bypassPermissions",
        "Create the hello file",
      ]);
      expect(res.status, diag(res)).toBe(0);
      const runId = /Run ID:\s+(\S+)/.exec(res.stdout)?.[1];
      expect(runId, diag(res)).toBeDefined();
      expect(res.stdout).toContain("Merged:     no\n");
      expect(res.stdout).toContain(
        `Result:     finished: work is on branch substrate/runs/${runId}, not merged (merging was turned off)\n`,
      );
      expect(res.stdout).toContain(`Next:       substrate merge ${runId}\n`);
      expect(res.stdout).toContain("Files:\n  contracts/types.ts\n  src/hello.txt\n");
      expect(existsSync(join(s.project, "src", "hello.txt"))).toBe(false);

      const merge = cli(s, ["merge", runId as string]);
      expect(merge.status, diag(merge)).toBe(0);
      expect(readFileSync(join(s.project, "src", "hello.txt"), "utf8")).toBe("hello\n");
      expect(git(s, ["log", "--format=%s", "-1"])).toContain(`merge run ${runId}`);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("a request with merge: true lands the run the same way --merge does", () => {
    const s = scratch(HELLO_CALLS());
    try {
      const request = JSON.stringify({
        goal: "Create the hello file",
        planner: { provider: "claude", model: "claude-sonnet-5-5" },
        worker: { provider: "claude", model: "haiku" },
        merge: true,
      });
      const res = cli(s, ["run", "--request", "-", "--output-format", "json", "--permission-mode", "bypassPermissions"], request);
      expect(res.status, diag(res)).toBe(0);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.merged, diag(res)).toBe(true);
      expect(readFileSync(join(s.project, "src", "hello.txt"), "utf8")).toBe("hello\n");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("a failed run's json names the failure class, the message and the drafts directory", () => {
    // Solo mode: the worker's edit never passes the verify command, so the run fails on verify.
    const s = scratch([
      { edits: { "a.txt": "wrong\n" }, reply: "first try\nDONE" },
      { edits: { "a.txt": "still wrong\n" }, reply: "heal try\nDONE" },
      { edits: { "a.txt": "again wrong\n" }, reply: "third try\nDONE" },
    ]);
    try {
      writeFileSync(join(s.project, "seed.txt"), "seed\n");
      git(s, ["init", "-q"]);
      git(s, ["add", "seed.txt"]);
      git(s, ["commit", "-q", "-m", "seed"]);
      const res = cli(s, [
        "run",
        "--mode", "solo",
        "--work", "claude:haiku",
        "--verify", "grep -q never-true a.txt",
        "--output-format", "json",
        "--permission-mode", "bypassPermissions",
        "make a.txt",
      ]);
      expect(res.status, diag(res)).not.toBe(0);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.exit_code).toBe(res.status);
      expect(summary.merged).toBe(false);
      expect(summary.failure_class, diag(res)).toBe("verify_failed");
      expect(typeof summary.message).toBe("string");
      expect(summary.drafts_dir).toBe(`.substrate/runs/${summary.run_id}`);
      // Known issue 41: a failed run names no resume command; with no passed task it names none at all.
      expect(summary.next).toEqual([]);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

