import fs from "node:fs";
import path from "node:path";

import type { EngineEvent, RunId, Settings, TaskId } from "../contracts/index.js";
import { buildSummary, exitCodeForState } from "../engine/engine.js";
import { type EngineState } from "../engine/reducer.js";
import { applyJournalEvent } from "../engine/journal.js";
import { loadSettings, withRequestedRoles } from "../config/index.js";
import { runLandedInHead } from "../git/landing.js";
import { getRunBranch } from "../git/workspace.js";
import { EventStoreImpl } from "../store/event-store.js";
import { runProcessOf } from "../store/run-lock.js";
const { runDirOf } = await import(`./run-files.js`);
const { RunProgress, followLines, progressLine, progressModelsFor } = await import(`./progress.js`);

/** The models a run names on its start line: the planner and worker `harness:model` (see progress.ts). */
type ProgressModels = { planner?: string; worker?: string };
type RunProgressState = InstanceType<typeof RunProgress>;

// Read-only views of a run for `status`, `watch` and `runs` (R10.2). Nothing here takes the run
// lock or writes: a run's state is the reduced journal, and its liveness is the lock's pid.

/** The states a run cannot leave by itself: its process has ended with one of these (R10.2). */
const TERMINAL_STATES: ReadonlySet<string> = new Set(["FINISHED", "PLANNED", "FAILED", "PAUSED", "CANCELLED"]);

export type RunStatus = "running" | "stopped" | "planned" | "finished" | "failed" | "paused" | "interrupted" | "cancelled";

export interface RunRecord {
  runId: string;
  runDir: string;
  events: EngineEvent[];
  state: EngineState;
  /** Wall-clock milliseconds of the run.created event, when there is one. */
  createdAt: number | undefined;
  /** Wall-clock milliseconds of the newest event. */
  lastEventAt: number | undefined;
  /** The process holding the run's lock, or undefined when no lock file exists. */
  process: { pid: number; alive: boolean } | undefined;
  terminal: boolean;
  status: RunStatus;
}

const INITIAL_STATE = (runId: string): EngineState => ({
  run_id: runId as RunId,
  state: "CREATED",
  tasks: {},
  usage: { total_usd: 0, by_role: {} },
  checkpoints: [],
});

/** The reduced state of a list of events (the same reduction resume and status use). */
// The journal's reduction: a run.finished sets the terminal state its exit code names, which the
// plain reducer does not (see journal.ts).
export function reduceEvents(runId: string, events: EngineEvent[]): EngineState {
  return events.reduce((state, ev) => applyJournalEvent(state, ev), INITIAL_STATE(runId));
}

/** True for a state the run cannot leave by itself: its process has ended with it. */
export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** The status word a run shows: a terminal state names itself, anything else is running only with a live process. */
export function statusOf(state: EngineState, alive: boolean): RunStatus {
  switch (state.state) {
    case "FINISHED":
      return "finished";
    case "PLANNED":
      return "planned";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "PAUSED":
      return state.pause_reason === "user_cancel" ? "interrupted" : "paused";
    default:
      return alive ? "running" : "stopped";
  }
}

/**
 * The one status word a run shows in text (R11.1, R11.3): `running`, `planned`, `finished`, `failed`,
 * `paused: budget`, `paused: needs your answers`, `paused: stopped by you` (a user stop), `paused: <reason>`,
 * or `stopped (process gone)`. The text header of `status` and the text listing of `runs` both use it, so a
 * run has one word in both. The JSON `status` field keeps the RunStatus values, `interrupted` included.
 */
export function statusWordOf(record: RunRecord): string {
  switch (record.status) {
    case "interrupted":
      return "paused: stopped by you";
    case "paused": {
      const reason = record.state.pause_reason;
      if (reason === "needs_human") return "paused: needs your answers";
      if (reason === "budget_exhausted") return "paused: budget";
      return `paused: ${reason ?? "paused"}`;
    }
    case "stopped":
      return "stopped (process gone)";
    default:
      return record.status;
  }
}

/**
 * Reads one run's journal and liveness. Undefined when the run has no events.jsonl. A corrupt
 * journal throws, as the engine's own reader does.
 */
export function readRun(cwd: string, runId: string): RunRecord | undefined {
  const runDir = runDirOf(cwd, runId);
  if (!fs.existsSync(path.join(runDir, "events.jsonl"))) return undefined;
  return recordOf(cwd, runId, new EventStoreImpl(runId as RunId, { runDir }).readAllSync());
}

/** The view of a run from its events: state, timing, and the liveness of its lock. */
export function recordOf(cwd: string, runId: string, events: EngineEvent[]): RunRecord {
  const state = reduceEvents(runId, events);
  const processInfo = runProcessOf(cwd, runId);
  const created = events.find((e) => e.type === "run.created");
  return {
    runId,
    runDir: runDirOf(cwd, runId),
    events,
    state,
    createdAt: created !== undefined ? Date.parse(created.ts) : undefined,
    lastEventAt: events.length > 0 ? Date.parse(events[events.length - 1].ts) : undefined,
    process: processInfo,
    terminal: isTerminalState(state.state),
    status: statusOf(state, processInfo?.alive === true),
  };
}

/** Every run in the project with a journal, newest first (by its creation time). */
export function listRuns(cwd: string): RunRecord[] {
  const runsDir = path.join(cwd, ".substrate", "runs");
  if (!fs.existsSync(runsDir)) return [];
  const records: RunRecord[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("r_")) continue;
    const record = readRun(cwd, entry.name);
    if (record !== undefined) records.push(record);
  }
  return records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.runId.localeCompare(a.runId));
}

/** The request a run was started with (the run.created prompt). */
export function requestOf(events: EngineEvent[]): string {
  const created = events.find((e) => e.type === "run.created");
  const prompt = (created?.data as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

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

/** The settings a run was started with, recovered from the roles its run.created recorded. */
export async function settingsOf(cwd: string, events: EngineEvent[]): Promise<Settings | undefined> {
  const created = events.find((e) => e.type === "run.created");
  const recorded = (created?.data as { requested_roles?: Record<string, unknown> } | undefined)?.requested_roles ?? {};
  try {
    return await loadSettings({
      projectDir: cwd,
      flags: withRequestedRoles({ roles: recorded }) as Partial<Settings>,
    });
  } catch {
    return undefined;
  }
}

/** The models a run names on its start line. */
export async function modelsOf(cwd: string, events: EngineEvent[]): Promise<ProgressModels> {
  const settings = await settingsOf(cwd, events);
  return settings !== undefined ? progressModelsFor(settings) : {};
}

/** One task of a run as a caller reads it (R10.2). */
export interface TaskRow {
  id: string;
  title: string | null;
  class: string | null;
  depends_on: string[];
  state: "passed" | "running" | "failed" | "waiting" | "skipped";
  generation: number;
  attempt: number;
  cost_usd: number;
  started_at: string | null;
  merged: boolean;
  failure_class: string | null;
}

export interface TaskCounts {
  passed: number;
  running: number;
  failed: number;
  waiting: number;
  skipped: number;
}

// The journal's task states as a caller reads them. A task waiting on another, not yet ready,
// or blocked is waiting; one whose worker, verify, merge or replan is in progress is running.
function displayState(raw: string): TaskRow["state"] {
  if (raw === "PASSED" || raw === "MERGED") return "passed";
  if (raw === "FAILED") return "failed";
  if (raw === "ABANDONED") return "skipped";
  if (["RUNNING", "SCOPE_CHECK", "VERIFYING", "HEALING", "MERGING", "REPLANNING"].includes(raw)) return "running";
  return "waiting";
}

/** Every task of the run: planned tasks in plan order, then any the journal names only. */
export function taskRowsOf(record: RunRecord): TaskRow[] {
  const plan = [...record.events].reverse().find((e) => e.type === "plan.produced");
  const planned = ((plan?.data as { tasks?: Array<Record<string, unknown>> } | undefined)?.tasks ?? []).filter(
    (t) => typeof t.id === "string",
  );
  const ids = planned.map((t) => t.id as string);
  for (const id of Object.keys(record.state.tasks)) {
    if (!ids.includes(id)) ids.push(id);
  }
  // R12.4: the repair attempts of a failed final check show as rows, after the plan's tasks.
  for (const id of Object.keys(record.state.repairs ?? {})) {
    if (!ids.includes(id)) ids.push(id);
  }
  const costs = new Map<string, number>();
  const started = new Map<string, string>();
  const merged = new Set<string>();
  for (const e of record.events) {
    const tid = (e.data as { task_id?: unknown } | undefined)?.task_id;
    if (typeof tid !== "string") continue;
    if (e.type === "usage.recorded") {
      const cost = Number((e.data as { record?: { cost_usd?: unknown } }).record?.cost_usd ?? 0);
      costs.set(tid, (costs.get(tid) ?? 0) + cost);
    } else if (e.type === "task.session.started") {
      started.set(tid, e.ts);
    } else if (e.type === "task.merged") {
      merged.add(tid);
    }
  }
  return ids.map((id) => {
    const entry = planned.find((t) => t.id === id);
    const task = record.state.tasks[id as TaskId] ?? record.state.repairs?.[id];
    const raw: string = task?.state ?? "PENDING";
    const dependsOn = Array.isArray(entry?.depends_on) ? (entry.depends_on as string[]) : [];
    return {
      id,
      title: typeof entry?.title === "string" ? entry.title : null,
      class: typeof entry?.class === "string" ? entry.class : null,
      depends_on: dependsOn,
      state: displayState(raw),
      generation: task?.generation ?? 1,
      attempt: task?.attempt ?? 1,
      cost_usd: costs.get(id) ?? 0,
      started_at: started.get(id) ?? null,
      merged: merged.has(id) || raw === "MERGED",
      failure_class: task?.failure_class ?? null,
    };
  });
}

export function countsOf(rows: TaskRow[]): TaskCounts {
  const count = (state: TaskRow["state"]): number => rows.filter((r) => r.state === state).length;
  return { passed: count("passed"), running: count("running"), failed: count("failed"), waiting: count("waiting"), skipped: count("skipped") };
}

/** The landing a finished run wrote, read from result.json when it exists (R10.2). */
export interface Outcome {
  summary_path: string | undefined;
  result_path: string | undefined;
  result: Record<string, unknown> | undefined;
}

export function outcomeOf(runDir: string, since?: number): Outcome {
  const summaryFile = path.join(runDir, "summary.txt");
  const resultFile = path.join(runDir, "result.json");
  // A file written before the run's newest event belongs to an earlier end of the run (a pause a
  // resume went on from), so it is not this run's outcome.
  const current = (file: string): boolean => {
    try {
      return fs.statSync(file).mtimeMs >= (since ?? 0);
    } catch {
      return false;
    }
  };
  let result: Record<string, unknown> | undefined;
  if (current(resultFile)) {
    try {
      result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, unknown>;
    } catch {
      result = undefined;
    }
  }
  return {
    summary_path: current(summaryFile) ? summaryFile : undefined,
    result_path: result !== undefined ? resultFile : undefined,
    result,
  };
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

/** The exit code a terminal run ends with: the one its result.json records, else the state's (R10.2). */
export function exitCodeOf(record: RunRecord): number {
  const recorded = record.terminal ? outcomeOf(record.runDir, record.lastEventAt).result?.exit_code : undefined;
  if (typeof recorded === "number") return recorded;
  return exitCodeForState(record.state.state as Parameters<typeof exitCodeForState>[0], record.state.pause_reason);
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

/** The lines of a progress log that open or resume it (`# ...`), with the time each names. */
export interface LogMark {
  at: number;
  text: string;
}

export function logMarksOf(runDir: string): LogMark[] {
  const file = path.join(runDir, "progress.log");
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const marks: LogMark[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("# ")) continue;
    const iso = line.trim().split(" ").pop() ?? "";
    const at = Date.parse(iso);
    if (!Number.isNaN(at)) marks.push({ at, text: line });
  }
  return marks;
}

/** A file of a run's directory, relative to the project, as the run names it: `.substrate/runs/<id>/<name>`. */
export function runPathOf(runId: string, name: string): string {
  return `.substrate/runs/${runId}/${name}`;
}
