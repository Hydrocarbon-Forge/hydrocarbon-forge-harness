import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// A planner's manifest may name a base_ref that does not resolve in the repository (the
// fake planner's manifest says `main`). The run's own base is authoritative, so the run
// completes and prints a note. These tests do not pin init.defaultBranch: the repository's
// branch is whatever `git init -b master` makes it.

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");

interface Scratch {
  root: string;
  project: string;
  env: Record<string, string>;
}

function scratch(calls: unknown[]): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-r75-base-"));
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
      GIT_AUTHOR_NAME: "R75 Test",
      GIT_AUTHOR_EMAIL: "r75@example.com",
      GIT_COMMITTER_NAME: "R75 Test",
      GIT_COMMITTER_EMAIL: "r75@example.com",
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

function diag(res: { status: number | null; stdout: string; stderr: string }): string {
  return `exit=${res.status}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

describe("R7.5: a planner base_ref that does not resolve", () => {
  it("manifest base_ref main in a master repository: the run completes, notes the ignored ref and never prints fatal", () => {
    const s = scratch([
      planCall(
        contractFiles(manifestFor("Create the hello file", ["T1"]), {
          "tasks/T1.md": taskSpec({ id: "T1", write: [], create: ["src/hello.txt"], verify: "grep -q hello src/hello.txt" }),
        }),
      ),
      { edits: { "src/hello.txt": "hello\n" }, reply: "T1 done\nDONE" },
    ]);
    try {
      // The repository's branch is master; the planner's manifest says main.
      execFileSync("git", ["init", "-q", "-b", "master"], { cwd: s.project, env: s.env });
      const res = cli(s, [
        "run",
        "--plan", "claude:claude-sonnet-5-5",
        "--work", "claude:haiku",
        "--merge",
        "--permission-mode", "bypassPermissions",
        "Create the hello file",
      ]);
      expect(res.status, diag(res)).toBe(0);
      expect(res.stdout, diag(res)).toMatch(/note: planner base_ref 'main' ignored; using run base [0-9a-f]{7}\n/);
      expect(res.stdout + res.stderr, diag(res)).not.toContain("fatal:");
      expect(readFileSync(join(s.project, "src", "hello.txt"), "utf8")).toBe("hello\n");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});
