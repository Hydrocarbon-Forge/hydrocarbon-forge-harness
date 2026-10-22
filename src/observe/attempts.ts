import fs from "node:fs";
import path from "node:path";

import type { WorkerReport } from "../contracts/index.js";

// The worker reports of a run (packets/<task>-g<n>-attempt<k>.json, the WorkerReport of each attempt), read whole.
// A torn or unreadable report is left out; the events still say what happened.

export interface AttemptReport {
  task_id: string;
  generation: number;
  attempt: number;
  file: string;
  report: WorkerReport;
}

const NAME = /^(.+)-g(\d+)-attempt(\d+)\.json$/;

export function attemptReportsOf(runDir: string): AttemptReport[] {
  const dir = path.join(runDir, "packets");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: AttemptReport[] = [];
  for (const name of names.sort()) {
    const m = NAME.exec(name);
    if (m === null) continue;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as WorkerReport;
      if (typeof report.task_id !== "string") continue;
      out.push({
        task_id: report.task_id,
        generation: Number(m[2]),
        attempt: Number(m[3]),
        file: path.join("packets", name),
        report,
      });
    } catch {
      // torn or unreadable: left out
    }
  }
  return out.sort((a, b) => a.generation - b.generation || a.attempt - b.attempt);
}
