import { describe, expect, it } from "vitest";

import { classifySetupFailure, classifyVerifyFailure, verifyNotRunReason } from "../../../src/engine/verify-outcome.js";
import { NOT_INSTALLED_MARKERS } from "../../../src/engine/verify-markers.js";
import type { VerifyFailure } from "../../../src/git/merger.js";

// R12.2: a final check that did not pass is a verdict (failed: the run fails) or no verdict at all
// (could_not_run: a warning, and the run finishes with the work merged).

const TSC_STUB =
  "This is not the tsc command you are looking for\n\nUse yarn to avoid accidentally running code from un-installed packages\n";

function failure(over: Partial<VerifyFailure>): VerifyFailure {
  return { command: "npx tsc -p tsconfig.json", exit_code: 1, timed_out: false, output: "", ...over };
}

describe("classifyVerifyFailure: a verdict is failed only for ordinary failure output", () => {
  it.each([
    ["an assertion failure (exit 1)", failure({ output: "AssertionError: expected 1 to be 0" }), "failed"],
    ["any other non-zero exit", failure({ exit_code: 2, output: "error TS2322: type mismatch" }), "failed"],
    ["a missing module that is not a tool marker", failure({ output: "Cannot find module './src/app'" }), "failed"],
    ["a marker in a different case (markers are case-sensitive)", failure({ output: TSC_STUB.toLowerCase() }), "failed"],
  ])("%s is failed", (_label, input, verdict) => {
    expect(classifyVerifyFailure(input)).toEqual({ verdict });
  });

  it("the stub tsc package from the R12.2 evidence is could_not_run: tsc is not installed", () => {
    expect(classifyVerifyFailure(failure({ exit_code: 1, output: TSC_STUB }))).toEqual({
      verdict: "could_not_run",
      reason: "tsc is not installed",
    });
  });

  it.each([
    ["exit 127: the command was not found", failure({ exit_code: 127, output: "" }), "the command was not found (exit 127)"],
    ["exit 126: the command cannot be executed", failure({ exit_code: 126, output: "" }), "the command could not be executed (exit 126)"],
    ["no exit code: the command could not be started", failure({ exit_code: null, output: "spawn ENOENT" }), "the command could not be started"],
    ["timed out: no verdict was produced", failure({ exit_code: null, timed_out: true, output: "" }), "timed out, so no verdict was produced"],
    ["npx has no command", failure({ exit_code: 1, output: "npx: command not found" }), "npx is not installed"],
    ["npx has no executable", failure({ exit_code: 1, output: "npm ERR! could not determine executable to run" }), "the tool has no executable to run"],
    ["bash reports the command missing", failure({ exit_code: 1, output: "bash: foo: command not found" }), "the command is not installed"],
    ["Windows reports the command missing", failure({ exit_code: 1, output: "'foo' is not recognized as an internal or external command" }), "the command is not installed"],
  ])("%s", (_label, input, reason) => {
    expect(classifyVerifyFailure(input)).toEqual({ verdict: "could_not_run", reason });
  });
});

describe("classifySetupFailure: a setup that failed means the check could not run", () => {
  it("names the exit code of the failed setup", () => {
    expect(classifySetupFailure({ command: "npm install", exit_code: 1, timed_out: false })).toEqual({
      verdict: "could_not_run",
      reason: "its setup failed (exit 1)",
    });
  });

  it("says a timed-out setup timed out", () => {
    expect(classifySetupFailure({ command: "npm install", exit_code: null, timed_out: true })).toEqual({
      verdict: "could_not_run",
      reason: "its setup failed (timed out)",
    });
  });
});

describe("NOT_INSTALLED_MARKERS: the documented list", () => {
  it("is exactly the list the classifier reads (a change here is a change of policy)", () => {
    expect(NOT_INSTALLED_MARKERS.map((m) => m.marker)).toEqual([
      "This is not the tsc command you are looking for",
      "could not determine executable to run",
      "npx: command not found",
      "command not found",
      "not recognized as an internal or external command",
    ]);
  });

  it("gives every marker a reason", () => {
    for (const m of NOT_INSTALLED_MARKERS) expect(m.reason.length).toBeGreaterThan(0);
  });

  // R13.1: a task's own verify gets the same classification. A missing tool passes the task with a reason; a real
  // failure with ordinary output is still a failure, even beside a command that could not run.
  const result = (cmd: string, exit_code: number | null, stderr_tail = "", stdout_tail = "", timed_out = false) => ({
    cmd,
    exit_code,
    timed_out,
    duration_ms: 1,
    stdout_tail,
    stderr_tail,
    truncated: false,
  });

  it("a verify whose tool is missing could not run, a real non-zero exit is no reason to pass", () => {
    expect(verifyNotRunReason([result("tsc --noEmit", 127)])).toBe("the command was not found (exit 127)");
    expect(verifyNotRunReason([result("npx tsc", 1, "", "Cannot find module 'typescript'")])).toBe(
      NOT_INSTALLED_MARKERS.find((m) => "Cannot find module 'typescript'".includes(m.marker))?.reason,
    );
    expect(verifyNotRunReason([result("npm test", 1, "", "expected true, got false")])).toBeUndefined();
    expect(verifyNotRunReason([result("npm test", 127), result("npm run lint", 2, "", "lint error")])).toBeUndefined();
    expect(verifyNotRunReason([result("npm test", 0)])).toBeUndefined();
  });
});
