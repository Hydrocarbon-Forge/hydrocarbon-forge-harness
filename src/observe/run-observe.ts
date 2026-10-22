import fs from "node:fs";
import path from "node:path";

import type { EngineEvent, RunId, Settings, TaskId } from "../contracts/index.js";
import { parseEngineEvent } from "../contracts/events.js";
import { exitCodeForState } from "../engine/engine.js";
import { type EngineState } from "../engine/reducer.js";
import { applyJournalEvent } from "../engine/journal.js";
import { loadSettings, withRequestedRoles } from "../config/index.js";
import { EventStoreImpl } from "../store/event-store.js";
import { listProjects } from "../store/projects.js";
import { runProcessOf } from "../store/run-lock.js";

// The neutral read model of a run (R10.2, web-ui design section 9 W1). `status`, `watch`, `runs`, `tasks`, `stop`,
// `resume` and the web server read runs through this module. Nothing here takes the run lock or writes: a run's
// state is the reduced journal, and its liveness is the lock's pid. Rendering (progress lines, summaries) and git
// lookups belong to the callers, not here.

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

/** A run of some project on this machine, with the project it belongs to (from the project registry). */
export interface ProjectRunRecord {
  project: string;
  projectName: string;
  record: RunRecord;
}

/** The state of a run before its first event. */
export const INITIAL_STATE = (runId: string): EngineState => ({
  run_id: runId as RunId,
  state: "CREATED",
  tasks: {},
  usage: { total_usd: 0, by_role: {} },
  checkpoints: [],
});

/** The run directory under a project: `.substrate/runs/<id>`. */
export function runDirOf(projectDir: string, runId: string): string {
  return path.join(projectDir, ".substrate", "runs", runId);
}

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

/** The journal of a run directory, read whole. A corrupt journal throws, as the engine's own reader does. */
export function readJournal(runDir: string, runId: string): EngineEvent[] {
  return new EventStoreImpl(runId as RunId, { runDir }).readAllSync();
}

/**
 * Reads one run's journal and liveness. Undefined when the run has no events.jsonl. A corrupt
 * journal throws, as the engine's own reader does.
 */
export function readRun(cwd: string, runId: string): RunRecord | undefined {
  const runDir = runDirOf(cwd, runId);
  if (!fs.existsSync(path.join(runDir, "events.jsonl"))) return undefined;
  return recordOf(cwd, runId, readJournal(runDir, runId));
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
  return sortNewestFirst(records);
}

function sortNewestFirst(records: RunRecord[]): RunRecord[] {
  return records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.runId.localeCompare(a.runId));
}

/**
 * Every run of every project in the registry, newest first. A project whose journal cannot be read is left out of
 * the listing; the other projects still show.
 */
export function listAllRuns(env: NodeJS.ProcessEnv = process.env): ProjectRunRecord[] {
  const rows: ProjectRunRecord[] = [];
  for (const project of listProjects(env)) {
    let records: RunRecord[];
    try {
      records = listRuns(project.path);
    } catch {
      continue;
    }
    for (const record of records) rows.push({ project: project.path, projectName: project.name, record });
  }
  return rows.sort((a, b) => (b.record.createdAt ?? 0) - (a.record.createdAt ?? 0) || b.record.runId.localeCompare(a.record.runId));
}

/** The newest run directory under a runs directory (by its modification time), or null when there is none. */
export function latestRunIdOf(runsDir: string): string | null {
  if (!fs.existsSync(runsDir)) return null;
  const candidates: { id: string; mtime: number }[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("r_")) {
      try {
        candidates.push({ id: entry.name, mtime: fs.statSync(path.join(runsDir, entry.name)).mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].id;
}

/**
 * Reads a run's events.jsonl through the catalog types only. Complete lines that are not catalog events are skipped;
 * a torn line (a partial write) is ignored, with one warning written to `stderr`.
 */
export function readCatalogEvents(
  eventsPath: string,
  stderr: Pick<NodeJS.WriteStream, "write">,
): ReturnType<typeof parseEngineEvent>[] {
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: ReturnType<typeof parseEngineEvent>[] = [];
  let warned = false;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warned = true;
      continue;
    }
    try {
      events.push(parseEngineEvent(parsed));
    } catch {
      // Not a catalog event: the CLI never reads it.
      continue;
    }
  }
  if (warned) {
    stderr.write(
      `warning: ${eventsPath} contains torn or unparsable lines; complete lines were used\n`
    );
  }
  return events;
}

/** The journal's reduction of the catalog events in a file (see readCatalogEvents), so a run names its terminal state. */
export function reduceRunEvents(
  eventsPath: string,
  stderr: Pick<NodeJS.WriteStream, "write">,
): {
  state: EngineState;
  events: ReturnType<typeof parseEngineEvent>[];
} {
  const events = readCatalogEvents(eventsPath, stderr);
  let state: EngineState = INITIAL_STATE("");
  for (const ev of events) {
    state = applyJournalEvent(state, ev);
  }
  return { state, events };
}

/** The request a run was started with (the run.created prompt). */
export function requestOf(events: EngineEvent[]): string {
  const created = events.find((e) => e.type === "run.created");
  const prompt = (created?.data as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" ? prompt : "";
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

/** The exit code a terminal run ends with: the one its result.json records, else the state's (R10.2). */
export function exitCodeOf(record: RunRecord): number {
  const recorded = record.terminal ? outcomeOf(record.runDir, record.lastEventAt).result?.exit_code : undefined;
  if (typeof recorded === "number") return recorded;
  return exitCodeForState(record.state.state as Parameters<typeof exitCodeForState>[0], record.state.pause_reason);
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
