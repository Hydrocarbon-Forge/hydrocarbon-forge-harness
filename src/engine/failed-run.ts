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

/**
 * The `Next:` lines of a failed run, in order: resume first, then the partial landing when a task
 * passed and the plan has integration verify, then a new request. A run that never planned is planned
 * again by resume (and costs again). An internal error adds the Substrate-bug line last.
 */
export function failedRunNext(
  runId: string,
  facts: { partialLandable: boolean; planningFailed: boolean; verifyOnly?: boolean; internalError?: boolean },
): string[] {
  // verifyOnly: every task merged and the final integration verify failed, so resume only runs that verify
  // again. The person fixes the run branch first (git switch substrate/runs/<id>, commit, then resume).
  const lines = [
    facts.planningFailed
      ? `substrate resume ${runId}  (plans again; planning costs again)`
      : facts.verifyOnly
        ? `substrate resume ${runId}  (runs integration verify again; fix the run branch first, then resume)`
        : `substrate resume ${runId}  (retries the failed tasks; passed tasks are kept)`,
  ];
  if (facts.partialLandable) {
    lines.push(`substrate merge ${runId} --partial  (lands the passed tasks after integration verify passes)`);
  }
  lines.push("Start a new run with a narrower request");
  // R9.1 (known issue 45): an unexpected exception is a Substrate bug, and the run directory keeps the evidence.
  if (facts.internalError) {
    lines.push(`This is a Substrate bug; the run directory keeps the event log: .substrate/runs/${runId}/`);
  }
  return lines;
}
