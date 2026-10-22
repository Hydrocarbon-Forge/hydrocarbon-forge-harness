import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { EngineEvent, RunId, RunSummary } from "../contracts/index.js";
import { buildRunReport, renderReportMarkdown, type AttemptFacts, type ReportFacts, type RunReport } from "../engine/run-report.js";
import { getRunBranch, runBranchExists } from "../git/workspace.js";
import { EventStoreImpl } from "../store/event-store.js";
const { writeReportMarkdown } = await import(`./run-files.js`);
const { runDirOf } = await import(`../observe/run-observe.js`);

// The disk side of the run report (P2.2): reads what a run left in its directory and its repository, and hands
// it to the pure builder in src/engine/run-report.ts. Nothing here takes the run lock or changes a run.

/** The run's events, read from events.jsonl; an unreadable log reads as no events. */
export function eventsOnDisk(cwd: string, runId: string): EngineEvent[] {
  try {
    return new EventStoreImpl(runId as RunId, { runDir: runDirOf(cwd, runId) }).readAllSync();
  } catch {
    return [];
  }
}

/** The file facts of a run: its branch and commits, its saved patches, and its worker attempt reports. */
export function reportFactsOnDisk(cwd: string, runId: string, events: EngineEvent[]): ReportFacts {
  const runDir = runDirOf(cwd, runId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(runDir, "packets"));
  } catch {
    names = [];
  }
  const attempts: AttemptFacts[] = [];
  for (const name of names) {
    if (!/-g\d+-attempt\d+\.json$/.test(name)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(runDir, "packets", name), "utf8")) as Record<string, unknown>;
      if (typeof r.task_id !== "string" || typeof r.generation !== "number" || typeof r.attempt !== "number") continue;
      attempts.push({
        task_id: r.task_id,
        generation: r.generation,
        attempt: r.attempt,
        files_changed: Array.isArray(r.files_changed) ? r.files_changed.filter((f): f is string => typeof f === "string") : [],
        verify: Array.isArray(r.verify) ? (r.verify as AttemptFacts["verify"]) : [],
      });
    } catch {
      // A torn or missing attempt report is left out; the events still say what happened.
    }
  }
  const created = events.find((e) => e.type === "run.created");
  const base = (created?.data as { base_branch?: unknown } | undefined)?.base_branch;
  const branch = runBranchExists(cwd, runId as RunId) ? getRunBranch(runId as RunId) : undefined;
  let commits: string[] = [];
  if (branch !== undefined && typeof base === "string") {
    try {
      commits = execFileSync("git", ["log", "--format=%s", `${base}..${branch}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter((line) => line !== "");
    } catch {
      commits = [];
    }
  }
  return {
    run_dir: `.substrate/runs/${runId}`,
    ...(branch !== undefined ? { branch } : {}),
    ...(typeof base === "string" ? { base_branch: base } : {}),
    commits,
    patches: names.filter((n) => n.endsWith(".patch")).sort(),
    attempts,
  };
}

/** The report of a run as it stands on disk. The summary is passed when the run has returned one. */
export function reportOfRun(cwd: string, runId: string, summary?: RunSummary): RunReport {
  const events = eventsOnDisk(cwd, runId);
  return buildRunReport({
    runId,
    events,
    ...(summary !== undefined ? { summary } : {}),
    facts: reportFactsOnDisk(cwd, runId, events),
  });
}

/** Writes REPORT.md for a run from what is on disk (best effort). Used when a run ends without a summary. */
export function writeRunReportFile(cwd: string, runId: string, summary?: RunSummary): RunReport {
  const report = reportOfRun(cwd, runId, summary);
  writeReportMarkdown(runDirOf(cwd, runId), renderReportMarkdown(report));
  return report;
}
