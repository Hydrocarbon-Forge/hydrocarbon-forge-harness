import fs from "node:fs";

import type { EngineEvent, RunId } from "../contracts/index.js";
import { buildSummary } from "../engine/engine.js";
import { type EngineState } from "../engine/reducer.js";
import { applyJournalEvent } from "../engine/journal.js";
import { runLandedInHead } from "../git/landing.js";
import { getRunBranch } from "../git/workspace.js";
import { INITIAL_STATE, outcomeOf, settingsOf, type RunRecord } from "../observe/run-observe.js";
import { followLines, progressLine, progressModelsFor, RunProgress } from "./progress.js";

// The parts of the run read model that only the CLI needs: the progress lines a run prints (the renderer a live
// run uses), its summary text, and the git check of whether its work is on the checked-out branch. The data
// model itself is in src/observe/run-observe.ts, which may not import the CLI.

/** The models a run names on its start line: the planner and worker `harness:model` (see progress.ts). */
type ProgressModels = { planner?: string; worker?: string };
type RunProgressState = InstanceType<typeof RunProgress>;

/**
 * The progress lines a journal produces, with the same renderer a live run uses (R10.2). A replay
 * starts the clock at the run's first event, so each line carries the `[mm:ss]` the run printed.
 */
export class RunReplay {
  private renderer: RunProgressState | undefined;
  state: EngineState;

  constructor(
    private readonly models: ProgressModels,
    runId: string,
  ) {
    this.state = INITIAL_STATE(runId);
  }

  /** The renderer's view of the run so far: phase, running tasks, merged count. Undefined before the first event. */
  get progress(): RunProgressState | undefined {
    return this.renderer;
  }

  /** Feeds one event; returns the lines it prints, each with its prefix and newline. */
  feed(event: EngineEvent): string[] {
    const at = Date.parse(event.ts);
    if (this.renderer === undefined) this.renderer = new RunProgress(this.models, at);
    const startedAt = this.renderer.startedAt;
    const bodies = this.renderer.observe(event, at);
    if (event.type === "run.created" || event.type === "run.resumed") {
      bodies.push(...followLines(String(event.run_id)));
    }
    this.state = applyJournalEvent(this.state, event);
    return bodies.map((body) => progressLine(body, at, startedAt));
  }
}

/** The models a run names on its start line. */
export async function modelsOf(cwd: string, events: EngineEvent[]): Promise<ProgressModels> {
  const settings = await settingsOf(cwd, events);
  return settings !== undefined ? progressModelsFor(settings) : {};
}

/** The summary block of a terminal run: the summary.txt the run wrote, else the renderer's view of its state. */
export async function summaryTextOf(cwd: string, record: RunRecord): Promise<string> {
  const outcome = outcomeOf(record.runDir, record.lastEventAt);
  if (outcome.summary_path !== undefined) return fs.readFileSync(outcome.summary_path, "utf8");
  const { renderSummaryText } = await import(`./output.js`);
  const first = record.events[0]?.ts;
  const last = record.events[record.events.length - 1]?.ts;
  const summary = buildSummary(record.runId as RunId, record.state, cwd);
  return renderSummaryText(summary, "", {
    startAt: first !== undefined ? Date.parse(first) : Date.now(),
    endAt: last !== undefined ? Date.parse(last) : Date.now(),
  });
}

/**
 * Whether a run's work is on the checked-out branch: the result.json landing when there is one,
 * else the run branch's ancestry (read only).
 */
export function mergedOf(cwd: string, record: RunRecord): boolean {
  const outcome = outcomeOf(record.runDir, record.lastEventAt);
  if (typeof outcome.result?.merged === "boolean") return outcome.result.merged;
  try {
    return runLandedInHead(cwd, getRunBranch(record.runId as RunId));
  } catch {
    return false;
  }
}
