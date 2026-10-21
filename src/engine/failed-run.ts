import fs from "node:fs";
import path from "node:path";

import { safeParseManifest } from "../engine/actions/shared.js";

// Known issue 41: a run that ended failed is not resumable, because the engine drops failed tasks
// by design. The summary's Next line, the json `next` and the refusal of `substrate resume` all say
// what the caller can do instead, and they say it the same way.

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

export interface FailedRunAdvice {
  /** The text after `Next:` in the summary. */
  next: string;
  /** What `substrate resume` says after `Run <id> failed and cannot be resumed.` */
  whatToDo: string;
}

/**
 * What a failed run can do instead of resuming. `partialLandable` is a run whose branch holds a
 * passed task and whose plan has integration verify: `merge --partial` lands that work. A run
 * that never planned (no tasks) must run again, and a run with tasks but nothing to land needs a
 * new request.
 */
export function failedRunAdvice(
  runId: string,
  facts: { partialLandable: boolean; planningFailed: boolean }
): FailedRunAdvice {
  if (facts.partialLandable) {
    return {
      next: `substrate merge ${runId} --partial  (lands the passed tasks after integration verify passes)`,
      whatToDo: `Land the passed tasks with: substrate merge ${runId} --partial`,
    };
  }
  if (facts.planningFailed) {
    return {
      next: "Run substrate run again (planning costs again)",
      whatToDo: "Run substrate run again (planning costs again).",
    };
  }
  return {
    next: "Start a new run with a narrower request",
    whatToDo: "Start a new run with a narrower request.",
  };
}
