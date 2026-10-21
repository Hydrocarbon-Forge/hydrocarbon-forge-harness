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

describe("R9.1: an unexpected engine error ends the run cleanly", () => {
  it("the text summary is printed, the stack is kept in error.txt, exit 1, and nothing is left behind", () => {
    const res = runBroken(["run", "--permission-mode", "bypassPermissions", "Build the internal error case"]);
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      // No raw error and no stack on stdout or stderr.
      expect(res.stdout, diagnostics(res)).not.toMatch(/^Error: /m);
      expect(res.stdout, diagnostics(res)).not.toMatch(/^\s+at /m);
      expect(res.stderr, diagnostics(res)).not.toMatch(/Error: |^\s+at /m);
      // The normal failed-run summary, with the reason and the next step.
      expect(res.stdout, diagnostics(res)).toContain("Status:     failed");
      expect(res.stdout, diagnostics(res)).toContain("Reason:     internal error: missing template variable: unknown_variable");
      // R10.4: the resume leads the Next lines; the Substrate-bug line comes last, under them.
      expect(res.stdout, diagnostics(res)).toMatch(/Next: +substrate resume r_\w+ {2}\(retries the failed tasks; passed tasks are kept\)\n/);
      expect(res.stdout, diagnostics(res)).toMatch(/\n {12}This is a Substrate bug; the run directory keeps the event log: \.substrate\/runs\/r_\w+\/\n/);
      expect(res.stdout, diagnostics(res)).toContain("Exit Code:  1");
      // The stack trace is in the run directory.
      expect(res.runDir, diagnostics(res)).not.toBeNull();
      const errorTxt = join(res.runDir as string, "error.txt");
      expect(existsSync(errorTxt), "error.txt written").toBe(true);
      const stack = readFileSync(errorTxt, "utf8");
      expect(stack).toContain("missing template variable: unknown_variable");
      expect(stack).toMatch(/\n\s+at /);
      // The event log ends with the terminal failure, which carries the class and the message.
      const last = res.events[res.events.length - 1];
      expect(last.type, diagnostics(res)).toBe("run.finished");
      expect(last.data, diagnostics(res)).toMatchObject({
        exit_code: 1,
        status: "failed",
        failure_class: "internal_error",
        message: "missing template variable: unknown_variable",
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

  it("the json result is the same failed run: failure_class internal_error, the message, exit 1", () => {
    const res = runBroken(["run", "--output-format", "json", "--permission-mode", "bypassPermissions", "Build the internal error case"]);
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.status, diagnostics(res)).toBe("failed");
      expect(summary.failure_class, diagnostics(res)).toBe("internal_error");
      expect(summary.message, diagnostics(res)).toBe("missing template variable: unknown_variable");
      expect(summary.exit_code, diagnostics(res)).toBe(1);
    } finally {
      res.cleanup();
    }
  });
});
