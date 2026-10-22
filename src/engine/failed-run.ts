import fs from "node:fs";
import path from "node:path";

import { safeParseManifest } from "../engine/actions/shared.js";

// R10.4 (known issue 41, reversed): a run that ended failed is resumable. `substrate resume` reopens it
// (failed tasks retry, passed tasks stay). The summary's Next lines and the json `next` say the same.

/** True when the run's plan has integration_verify commands (read from its manifest). */
export function planHasIntegrationVerify(runDir: string): boolean {
  const file = path.join(runDir, "manifest.yaml");
  if (!fs.existsSync(file)) return false;
  try {
    return (safeParseManifest(fs.readFileSync(file, "utf8"), file).integration_verify ?? []).length > 0;
  } catch {
    return false;
  }
}

/** The facts that pick a failed run's resume lines (see failedRunResume). */
export interface FailedRunFacts {
  partialLandable: boolean;
  planningFailed: boolean;
  verifyOnly?: boolean;
  internalError?: boolean;
}

/**
 * The resume line of a failed run, and the partial landing line when a passed task can land. Shared by the
 * summary, the json `next`, `status` and the run report, so every surface names the same commands.
 */
export function failedRunResume(runId: string, facts: FailedRunFacts): string[] {
  // verifyOnly: every task merged and the final integration verify failed, so resume only runs that verify
  // again. The person switches to the run branch, commits the fix, then resumes.
  const lines = [
    facts.planningFailed
      ? `substrate resume ${runId}  (plans again; planning costs again)`
      : facts.verifyOnly
        ? `substrate resume ${runId}  (runs integration verify again; fix the run branch first, then resume: git switch substrate/runs/${runId}, commit, resume)`
        : `substrate resume ${runId}  (retries the failed tasks; passed tasks are kept)`,
  ];
  if (facts.partialLandable) {
    lines.push(`substrate merge ${runId} --partial  (lands the passed tasks after integration verify passes)`);
  }
  return lines;
}

/**
 * The closing lines of a failed run: a new request, and for an internal error the Substrate-bug line (R9.1,
 * known issue 45): an unexpected exception is a Substrate bug, and the run directory keeps the evidence.
 */
export function failedRunTail(runId: string, facts: { internalError?: boolean }): string[] {
  const lines = ["Start a new run with a narrower request"];
  if (facts.internalError) {
    lines.push(`This is a Substrate bug; the run directory keeps the event log: .substrate/runs/${runId}/`);
  }
  return lines;
}

/** The `Next:` lines of a failed run, in order: the resume lines, then a new request (and the bug line when internal). */
export function failedRunNext(runId: string, facts: FailedRunFacts): string[] {
  return [...failedRunResume(runId, facts), ...failedRunTail(runId, facts)];
}
