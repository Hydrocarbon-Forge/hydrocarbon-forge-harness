import type { SetupFailure } from "../git/setup.js";
import type { VerifyFailure } from "../git/merger.js";
import { NOT_INSTALLED_MARKERS } from "./verify-markers.js";

// What a final check said (R12.2). `failed` is a verdict: the commands ran and one exited non-zero
// with ordinary output, so the run fails. `could_not_run` is no verdict: a tool was missing, a
// command could not be started, the setup failed, or the command timed out. Such a check is a
// warning, and the run finishes with the work merged but not verified as a whole.

export type CheckVerdict =
  | { verdict: "failed" }
  | { verdict: "could_not_run"; reason: string };

const could = (reason: string): CheckVerdict => ({ verdict: "could_not_run", reason });

/** Classifies a verify command that did not pass: a verdict of failed, or could_not_run with its reason. */
export function classifyVerifyFailure(failure: VerifyFailure): CheckVerdict {
  if (failure.timed_out) return could("timed out, so no verdict was produced");
  // 127: the shell found no such command. 126: it found one that cannot be executed.
  if (failure.exit_code === 127) return could("the command was not found (exit 127)");
  if (failure.exit_code === 126) return could("the command could not be executed (exit 126)");
  // No exit code: the process could not be started at all.
  if (failure.exit_code === null) return could("the command could not be started");
  const missing = NOT_INSTALLED_MARKERS.find((m) => failure.output.includes(m.marker));
  if (missing !== undefined) return could(missing.reason);
  return { verdict: "failed" };
}

/** A setup that failed means the check could not run: its tooling was never installed. */
export function classifySetupFailure(failure: SetupFailure): { verdict: "could_not_run"; reason: string } {
  const status = failure.timed_out ? "timed out" : `exit ${failure.exit_code}`;
  return { verdict: "could_not_run", reason: `its setup failed (${status})` };
}
