import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R9.1 (known issue 45): an unexpected exception ends the run as a failed run, cleanly. The stack
// goes to error.txt in the run directory; stdout gets the normal failed summary with the reason
// `internal error: <message>`; the worktrees and task branches are swept; exit 1.
//
// The exception is injected through the project's prompt override (.substrate/prompts/worker/task.md),
// a template that names a variable the worker does not supply, so the worker's prompt render throws
// inside a real action. No test hook is added to src/.

const BROKEN_TEMPLATE = "Work on {{spec_path}} and {{unknown_variable}}.\n";

function singleTaskPlan(): Record<string, string> {
  return contractFiles(manifestFor("Internal error", ["T1"], "echo verify all"), {
    "tasks/T1.md": taskSpec({ id: "T1", title: "Create the file", write: [], create: ["src/t1.txt"], verify: "test -f src/t1.txt" }),
  });
}

function runBroken(args: string[]): RunSubstrateResult {
  return runSubstrate({
    files: { "contracts/types.ts": CONTRACT_STUB },
    beforeRun: (repo) => {
      mkdirSync(join(repo.dir, ".substrate", "prompts", "worker"), { recursive: true });
      writeFileSync(join(repo.dir, ".substrate", "prompts", "worker", "task.md"), BROKEN_TEMPLATE, "utf8");
    },
    scenario: { calls: [planCall(singleTaskPlan())] },
    args,
    timeoutMs: 180000,
  });
}

function diagnostics(res: RunSubstrateResult): string {
  return `exit=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

function git(res: RunSubstrateResult, args: string[]): string {
  return execFileSync("git", args, { cwd: res.repoDir, encoding: "utf8" }).trim();
}

// 2026-10-23 (owner, d): an exception inside one task's worker is that task's failure, not a run-level internal
// error. The task is BLOCKED with the error text, the stack is kept under packets/, and the run ends failed with exit 1.
// A run-level internal error (an exception outside any one task) keeps error.txt; this file covers the task boundary.
describe("R9.1 / 2026-10-23 (d): an unexpected exception inside a task ends that task, cleanly", () => {
  it("the text summary names the task failure, the stack is kept under packets/, exit 1, and nothing is left behind", () => {
    const res = runBroken(["run", "--permission-mode", "bypassPermissions", "Build the internal error case"]);
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      // No raw error and no stack on stdout or stderr.
      expect(res.stdout, diagnostics(res)).not.toMatch(/^Error: /m);
      expect(res.stdout, diagnostics(res)).not.toMatch(/^\s+at /m);
      expect(res.stderr, diagnostics(res)).not.toMatch(/Error: |^\s+at /m);
      // The normal failed-run summary, with the reason and the next step.
      expect(res.stdout, diagnostics(res)).toContain("Status:     failed");
      expect(res.stdout, diagnostics(res)).toContain("missing template variable: unknown_variable");
      // R10.4: the resume leads the Next lines (the task is retried), and the run is not an internal error.
      expect(res.stdout, diagnostics(res)).toMatch(/Next: +substrate resume r_\w+ {2}\(retries the failed tasks; passed tasks are kept\)\n/);
      expect(res.stdout, diagnostics(res)).not.toContain("This is a Substrate bug");
      expect(res.stdout, diagnostics(res)).toContain("Exit Code:  1");
      // The stack trace is kept in the run directory, next to the task's packet.
      expect(res.runDir, diagnostics(res)).not.toBeNull();
      const stackFile = join(res.runDir as string, "packets", "T1-exception.txt");
      expect(existsSync(stackFile), "task exception file written").toBe(true);
      const stack = readFileSync(stackFile, "utf8");
      expect(stack).toContain("missing template variable: unknown_variable");
      expect(stack).toMatch(/\n\s+at /);
      // The event log ends with the terminal failure: the task failed with the error text, the run is failed.
      const failedTask = res.events.find((e) => e.type === "task.failed");
      expect(failedTask?.data, diagnostics(res)).toMatchObject({ task_id: "T1", can_replan: false, failure_class: "worker_crashed" });
      expect(String((failedTask?.data as any).detail), diagnostics(res)).toContain("missing template variable: unknown_variable");
      const last = res.events[res.events.length - 1];
      expect(last.type, diagnostics(res)).toBe("run.finished");
      expect(last.data, diagnostics(res)).toMatchObject({
        exit_code: 1,
        status: "failed",
        reason: "tasks_failed",
        failed_tasks: ["T1"],
      });
      expect(res.events.filter((e) => e.type === "run.finished").length, diagnostics(res)).toBe(1);
      // Worktrees and task branches are swept; the run branch stays (it names the run).
      const worktrees = git(res, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
      expect(worktrees, "no worktree left but the repository itself").toEqual([`worktree ${res.repoDir}`]);
      expect(git(res, ["branch", "--list", "substrate/tasks/*"]), "no task branch left").toBe("");
    } finally {
      res.cleanup();
    }
  });

  it("the json result is the same failed run: the task's failure class and its message, exit 1", () => {
    const res = runBroken(["run", "--output-format", "json", "--permission-mode", "bypassPermissions", "Build the internal error case"]);
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.status, diagnostics(res)).toBe("failed");
      expect(summary.failure_class, diagnostics(res)).toBe("worker_crashed");
      expect(summary.tasks.T1.failure_class, diagnostics(res)).toBe("worker_crashed");
      expect(summary.exit_code, diagnostics(res)).toBe(1);
    } finally {
      res.cleanup();
    }
  });
});
