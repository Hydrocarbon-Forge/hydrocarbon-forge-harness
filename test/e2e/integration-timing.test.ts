import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R9.1 (known issue 44): integration_verify is a whole-project command. It runs once, at the final
// gate, after every task of the plan has merged. Mid-run merges land each task on the run branch
// without a whole-project verify between them. The scenario is the live snake run r_4JRK6NGFMVQD: a
// test-first plan whose T1 tests are red until its dependent T2 is merged.

const INTEGRATION = "sh -c 'test -f test/game.txt && test -f src/game.txt && test -f src/ui.txt'";
const RUN_ARGS = ["run", "--merge", "--permission-mode", "bypassPermissions", "Build the snake game"];

/** The three-task plan: T1 writes the tests, T2 (after T1) implements the logic, T3 builds the UI. */
function snakePlan(integration: string): Record<string, string> {
  const manifest = manifestFor("Snake game", ["T1", "T2", "T3"], integration);
  return contractFiles(manifest, {
    "tasks/T1.md": taskSpec({
      id: "T1",
      title: "Write behaviour tests for the Snake game logic",
      write: [],
      create: ["test/game.txt"],
      verify: "grep -q tests-written test/game.txt",
    }),
    "tasks/T2.md": taskSpec({
      id: "T2",
      title: "Implement the Snake game logic module",
      dependsOn: ["T1"],
      write: [],
      create: ["src/game.txt"],
      verify: "grep -q impl-done src/game.txt",
    }),
    "tasks/T3.md": taskSpec({
      id: "T3",
      title: "Build the browser UI, input handling and game loop",
      write: [],
      create: ["src/ui.txt"],
      verify: "grep -q ui-done src/ui.txt",
    }),
  });
}

function workerCall(task: string, file: string, content: string): Record<string, unknown> {
  return { task, edits: { [file]: content }, reply: `${task} done\nDONE` };
}

function git(res: RunSubstrateResult, args: string[]): string {
  return execFileSync("git", args, { cwd: res.repoDir, encoding: "utf8" }).trim();
}

function diagnostics(res: RunSubstrateResult): string {
  return `exit=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

function eventsOf(res: RunSubstrateResult, type: string): Array<{ seq: number; data: any }> {
  return res.events.filter((e) => e.type === type).map((e) => ({ seq: e.seq, data: e.data }));
}

describe("R9.1: integration verify runs once, after every task has merged", () => {
  it("T1: the live snake plan finishes 3/3 passed, verify runs once after the last merge, and everything lands", () => {
    const res = runSubstrate({
      files: { "contracts/types.ts": CONTRACT_STUB },
      scenario: {
        calls: [
          planCall(snakePlan(INTEGRATION)),
          workerCall("T1", "test/game.txt", "tests-written\n"),
          workerCall("T3", "src/ui.txt", "ui-done\n"),
          workerCall("T2", "src/game.txt", "impl-done\n"),
        ],
      },
      settings: { concurrency: { workers: 3 } },
      args: RUN_ARGS,
      timeoutMs: 180000,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const merged = eventsOf(res, "task.merged");
      expect(merged.map((m) => m.data.task_id).sort(), diagnostics(res)).toEqual(["T1", "T2", "T3"]);
      const started = eventsOf(res, "integration.started");
      expect(started.length, diagnostics(res)).toBe(1);
      const lastMerge = Math.max(...merged.map((m) => m.seq));
      expect(started[0].seq, diagnostics(res)).toBeGreaterThan(lastMerge);
      expect(eventsOf(res, "integration.finished").length, diagnostics(res)).toBe(1);
      expect(eventsOf(res, "bisect.started").length, diagnostics(res)).toBe(0);
      expect(res.stdout, diagnostics(res)).toContain("Merged:     yes");
      for (const file of ["test/game.txt", "src/game.txt", "src/ui.txt"]) {
        expect(existsSync(join(res.repoDir, file)), `${file} on the user's branch`).toBe(true);
      }
      expect(readFileSync(join(res.repoDir, "src/game.txt"), "utf8")).toBe("impl-done\n");
    } finally {
      res.cleanup();
    }
  });

  it("T2: a broken implementation fails the final verify: the run fails gracefully, names no culprit, and leaves nothing behind", () => {
    // T2 passes its own check (impl-done) but not the whole-project one (complete): no blameable
    // prefix can be shown to pass, so bisect names no task.
    const integration = "sh -c 'test -f test/game.txt && test -f src/game.txt && test -f src/ui.txt && grep -q complete src/game.txt'";
    const res = runSubstrate({
      files: { "contracts/types.ts": CONTRACT_STUB },
      scenario: {
        calls: [
          planCall(snakePlan(integration)),
          workerCall("T1", "test/game.txt", "tests-written\n"),
          workerCall("T3", "src/ui.txt", "ui-done\n"),
          workerCall("T2", "src/game.txt", "impl-done\n"),
        ],
      },
      settings: { concurrency: { workers: 3 } },
      args: RUN_ARGS,
      timeoutMs: 180000,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      expect(res.stdout, diagnostics(res)).toContain("Status:     failed");
      expect(res.stdout, diagnostics(res)).toMatch(/Reason: {5}integration_failed: sh -c .* exited 1\n/);
      expect(res.stdout, diagnostics(res)).toContain("Merged:     no");
      expect(res.stdout, diagnostics(res)).toContain("Tasks:      3 passed / 3 total");
      expect(eventsOf(res, "bisect.culprit").length, diagnostics(res)).toBe(0);
      expect(eventsOf(res, "replan.started").length, diagnostics(res)).toBe(0);
      expect(eventsOf(res, "integration.failed").length, diagnostics(res)).toBe(1);
      expect(res.stderr, diagnostics(res)).not.toMatch(/Error|    at /);
      const last = res.events[res.events.length - 1];
      expect(last.type, diagnostics(res)).toBe("run.finished");
      expect((last.data as { exit_code: number }).exit_code).toBe(1);
      expect(existsSync(join(res.repoDir, "src/game.txt")), "nothing merged to the user's branch").toBe(false);
      // The run branch stays: it holds the passed work (the summary names it). Task branches are swept.
      expect(git(res, ["branch", "--list", "substrate/tasks/*"]), "no task branch left").toBe("");
      const branch = /Branch: +(\S+)/.exec(res.stdout)?.[1] ?? "";
      expect(git(res, ["branch", "--list", "substrate/runs/*"]).replace(/^\*? */, ""), "only the run branch").toBe(branch);
      const worktrees = git(res, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
      expect(worktrees, "no worktree left but the repository itself").toEqual([`worktree ${res.repoDir}`]);
    } finally {
      res.cleanup();
    }
  });

  it("T3: a final verify that fails on every state names no culprit and fails the run gracefully", () => {
    const res = runSubstrate({
      files: { "contracts/types.ts": CONTRACT_STUB },
      scenario: {
        calls: [
          planCall(snakePlan("sh -c 'test -f src/never.txt'")),
          workerCall("T1", "test/game.txt", "tests-written\n"),
          workerCall("T3", "src/ui.txt", "ui-done\n"),
          workerCall("T2", "src/game.txt", "impl-done\n"),
        ],
      },
      settings: { concurrency: { workers: 3 } },
      args: RUN_ARGS,
      timeoutMs: 180000,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      expect(eventsOf(res, "bisect.culprit").length, diagnostics(res)).toBe(0);
      expect(res.events.some((e) => e.type === "task.failed"), diagnostics(res)).toBe(false);
      expect(res.stdout, diagnostics(res)).toContain("Reason:     integration_failed: sh -c 'test -f src/never.txt' exited 1");
      expect(res.stderr, diagnostics(res)).not.toMatch(/Error|    at /);
    } finally {
      res.cleanup();
    }
  });

  it("T4: a culprit found at the final gate (already merged) is replanned, and the run finishes", () => {
    // Concurrency 1 merges T1, T2, T3 in plan order: the base and the prefix {T1, T2} pass, and the
    // full order fails only because T3 wrote a file the check does not accept.
    const integration = "sh -c 'test ! -f src/ui.txt || grep -q ui-ok src/ui.txt'";
    const plan = contractFiles(manifestFor("Snake game", ["T1", "T2", "T3"], integration), {
      "tasks/T1.md": taskSpec({ id: "T1", title: "Write the tests", write: [], create: ["test/game.txt"], verify: "grep -q tests-written test/game.txt" }),
      "tasks/T2.md": taskSpec({ id: "T2", title: "Implement the logic", dependsOn: ["T1"], write: [], create: ["src/game.txt"], verify: "grep -q impl-done src/game.txt" }),
      "tasks/T3.md": taskSpec({ id: "T3", title: "Build the UI", write: [], create: ["src/ui.txt"], verify: "test -f src/ui.txt" }),
    });
    const revised3 = taskSpec({
      id: "T3",
      title: "Build the UI and write ui-ok",
      write: [],
      create: ["src/ui.txt"],
      verify: "test -f src/ui.txt",
      marker: "ui-ok",
    });
    const res = runSubstrate({
      files: { "contracts/types.ts": CONTRACT_STUB },
      scenario: {
        calls: [
          planCall(plan),
          workerCall("T1", "test/game.txt", "tests-written\n"),
          workerCall("T2", "src/game.txt", "impl-done\n"),
          workerCall("T3", "src/ui.txt", "ui-broken\n"),
          { plan: { files: { "tasks/T3.md": revised3 } }, reply: "the UI must write ui-ok\nREVISED T3" },
          workerCall("T3", "src/ui.txt", "ui-ok\n"),
        ],
      },
      settings: { concurrency: { workers: 1 } },
      args: RUN_ARGS,
      timeoutMs: 180000,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(eventsOf(res, "bisect.culprit").map((c) => c.data.culprit_task_id), diagnostics(res)).toEqual(["T3"]);
      expect(eventsOf(res, "replan.started").length, diagnostics(res)).toBeGreaterThan(0);
      expect(eventsOf(res, "integration.started").length, diagnostics(res)).toBe(2);
      expect(res.stdout, diagnostics(res)).toContain("Merged:     yes");
    } finally {
      res.cleanup();
    }
  });
});
