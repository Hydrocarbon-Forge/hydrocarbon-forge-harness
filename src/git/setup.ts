import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../contracts/index.js";
import { VerifyRunner } from "../verify/runner.js";

// The plan's setup commands (manifest `setup`) run in every worktree that runs a check: each task
// worktree before its worker (src/roles/worker.ts) and the integration worktree before the final
// verify (src/engine/actions/integrate.ts, src/cli/commands/merge.ts). One helper, so the two
// cannot diverge: a check that needs installed dependencies finds them wherever it runs.

/** The setup output kept for a worker's prompt: the last ~1 KB of the failed command's output (R13.1). */
const SETUP_OUTPUT_TAIL_CHARS = 1024;

/**
 * The command that failed a setup: its text, its exit code (null when it timed out or could not start),
 * whether it timed out, and the tail of its output (empty when it could not start).
 */
export interface SetupFailure {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  output_tail?: string;
}

export type SetupOutcome = { passed: true; ran: number } | { passed: false; ran: number; failure: SetupFailure };

/**
 * Runs the setup commands in one worktree, in order, and stops at the first that fails or times
 * out. A command that cannot be started counts as failed (exit code null).
 */
export async function runSetupCommands(worktreePath: string, commands: Command[]): Promise<SetupOutcome> {
  const runner = new VerifyRunner();
  let ran = 0;
  for (const cmd of commands) {
    let result;
    try {
      [result] = await runner.runVerify({ cwd: worktreePath, commands: [cmd], sandbox: false, network: "allow" });
    } catch {
      return { passed: false, ran, failure: { command: cmd.run, exit_code: null, timed_out: false, output_tail: "" } };
    }
    ran += 1;
    if (result.exit_code !== 0 || result.timed_out) {
      return {
        passed: false,
        ran,
        failure: {
          command: cmd.run,
          exit_code: result.timed_out ? null : result.exit_code,
          timed_out: result.timed_out,
          output_tail: `${result.stdout_tail}${result.stderr_tail}`.slice(-SETUP_OUTPUT_TAIL_CHARS),
        },
      };
    }
  }
  return { passed: true, ran };
}

/**
 * The marker that says a worktree's setup is done. It sits in the worktree's git directory, which
 * git removes with the worktree, so a worktree created again (after a resume) runs the setup again,
 * while repair attempts and re-verifies in the same worktree do not reinstall.
 */
function setupMarkerPath(worktreePath: string): string {
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  return join(gitDir, "substrate-setup-done");
}

/**
 * Runs the setup once in a worktree. Returns undefined when there is nothing to run (no commands,
 * or the worktree is already set up); otherwise the outcome, which the caller can report. A
 * passing setup leaves the marker; a failing one does not.
 */
export async function setUpWorktree(
  worktreePath: string,
  commands: Command[],
  hooks: { onStart?: (count: number) => void; onFinish?: (outcome: SetupOutcome) => void } = {},
): Promise<SetupOutcome | undefined> {
  if (commands.length === 0) return undefined;
  const marker = setupMarkerPath(worktreePath);
  if (existsSync(marker)) return undefined;
  hooks.onStart?.(commands.length);
  const outcome = await runSetupCommands(worktreePath, commands);
  if (outcome.passed) writeFileSync(marker, "done\n", "utf8");
  hooks.onFinish?.(outcome);
  return outcome;
}
