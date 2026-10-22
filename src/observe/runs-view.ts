import fs from "node:fs";
import path from "node:path";

import type { EngineEvent, TaskId, UsageRecord, VerifyResult } from "../contracts/index.js";
import { listProjects, type ProjectEntry } from "../store/projects.js";
import {
  countsOf,
  listRuns,
  readRun,
  statusWordOf,
  taskRowsOf,
  type RunRecord,
  type RunStatus,
} from "./run-observe.js";
import { attemptReportsOf } from "./attempts.js";
import { artifactIndexOf, refOf as artifactRefOf, type ArtifactRef } from "./artifacts.js";
import { sessionsOf, type SessionRef } from "./transcripts.js";
import { projectIdOf, usageOfRows, type Usage } from "./usage.js";

// The run views of the web API (docs/design/web-ui.md, 5.1 and 5.2): RunSummary, RunDetail, the task rows and the
// integration state. Every value is read from the run directory and its journal; nothing is written.

export interface ModelChoice {
  provider: string;
  model: string;
  effort: string | null;
}

export interface RunSummary {
  ref: string;
  project_id: string;
  project_name: string;
  run_id: string;
  request: string;
  status: RunStatus;
  status_word: string;
  live: boolean;
  planner: ModelChoice;
  worker: ModelChoice;
  started_at: string;
  ended_at: string | null;
  elapsed_ms: number;
  branch: string | null;
  merged: boolean | null;
  usage: Usage;
  tasks: { total: number; passed: number; running: number; failed: number; skipped: number };
  pause_reason: string | null;
}

export interface TaskRowApi {
  id: string;
  title: string;
  class: string;
  state: string;
  generation: number;
  attempt: number;
  session_ids: string[];
  failure_class: string | null;
  failure_message: string | null;
  files_changed: string[];
  cost_usd: number;
  elapsed_ms: number;
  verify: "passed" | "failed" | "timed_out" | "not_run" | null;
}

export interface IntegrationApi {
  verdict: "pending" | "verifying" | "passed" | "failed" | "could_not_run" | "skipped";
  verify: VerifyResult[];
  repairs: { attempt: number; outcome: "passed" | "failed"; session_id: string | null }[];
}

/** The run detail. Its `tasks` are the task rows (the summary's `tasks` are the counts, docs/design/web-ui.md 5.1). */
export interface RunDetail extends Omit<RunSummary, "tasks"> {
  tasks: TaskRowApi[];
  pause_question: string | null;
  verification: "passed" | "failed" | "skipped" | "not_run" | null;
  verification_note: string | null;
  report_text: string | null;
  sessions: SessionRef[];
  planner_session_ids: string[];
  integration: IntegrationApi;
  artifacts: ArtifactRef[];
  chat_available: boolean;
}

/** A run of a registered project, with the project it belongs to. */
export interface ProjectRun {
  project: ProjectEntry;
  projectId: string;
  record: RunRecord;
}

const UNKNOWN_MODEL: ModelChoice = { provider: "unknown", model: "unknown", effort: null };
const REF_PART = /^[A-Za-z0-9_-]+$/;
const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(["PASSED", "MERGED", "FAILED", "ABANDONED"]);

/** A ref is `<projectId>~<runId>`; both parts are plain identifiers. Undefined for any other text. */
export function parseRef(ref: string): { projectId: string; runId: string } | undefined {
  const parts = ref.split("~");
  if (parts.length !== 2) return undefined;
  const [projectId, runId] = parts;
  if (!REF_PART.test(projectId) || !REF_PART.test(runId)) return undefined;
  return { projectId, runId };
}

export function runRefOf(projectId: string, runId: string): string {
  return `${projectId}~${runId}`;
}

/** The project a ref names, or undefined when no registered project has that id. */
export function projectOfId(env: NodeJS.ProcessEnv, projectId: string): ProjectEntry | undefined {
  return listProjects(env).find((p) => projectIdOf(p.path) === projectId);
}

/** One run of one project, by its ref. Undefined when the project is not registered or the run has no journal. */
export function runOfRef(env: NodeJS.ProcessEnv, ref: string): ProjectRun | undefined {
  const parsed = parseRef(ref);
  if (parsed === undefined) return undefined;
  const project = projectOfId(env, parsed.projectId);
  if (project === undefined) return undefined;
  const record = readRun(project.path, parsed.runId);
  if (record === undefined) return undefined;
  return { project, projectId: parsed.projectId, record };
}

/**
 * The runs of every registered project (or of one, when `project` names its id or path), live runs first, then
 * newest first. A project whose journal cannot be read is left out of the list.
 */
export function projectRunsOf(env: NodeJS.ProcessEnv, project?: string): ProjectRun[] {
  const rows: ProjectRun[] = [];
  for (const entry of listProjects(env)) {
    const projectId = projectIdOf(entry.path);
    if (project !== undefined && project !== projectId && project !== entry.path) continue;
    let records: RunRecord[];
    try {
      records = listRuns(entry.path);
    } catch {
      continue;
    }
    for (const record of records) rows.push({ project: entry, projectId, record });
  }
  return rows.sort((a, b) => {
    const live = Number(b.record.process?.alive === true) - Number(a.record.process?.alive === true);
    if (live !== 0) return live;
    return (b.record.createdAt ?? 0) - (a.record.createdAt ?? 0) || b.record.runId.localeCompare(a.record.runId);
  });
}

function eventOf(record: RunRecord, type: string): EngineEvent | undefined {
  return record.events.find((e) => e.type === type);
}

function isoOf(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

/** The models a run used: the ones its run.created recorded, else the first session of each role. */
function modelsOf(record: RunRecord, sessions: () => SessionRef[]): { planner: ModelChoice; worker: ModelChoice } {
  const created = eventOf(record, "run.created");
  const requested = (created?.data as { requested_roles?: Record<string, unknown> } | undefined)?.requested_roles ?? {};
  const fromRequest = (value: unknown): ModelChoice | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const role = value as { backend?: unknown; provider?: unknown; model?: unknown; effort?: unknown };
    if (typeof role.model !== "string") return undefined;
    const provider = typeof role.backend === "string" ? role.backend : typeof role.provider === "string" ? role.provider : "unknown";
    return { provider, model: role.model, effort: typeof role.effort === "string" ? role.effort : null };
  };
  const fromSession = (role: SessionRef["role"]): ModelChoice | undefined => {
    const session = sessions().find((s) => s.role === role);
    return session === undefined ? undefined : { provider: session.backend, model: session.model, effort: null };
  };
  return {
    planner: fromRequest(requested.planner) ?? fromSession("planner") ?? UNKNOWN_MODEL,
    worker: fromRequest(requested.worker) ?? fromSession("worker") ?? UNKNOWN_MODEL,
  };
}

/** The usage a run's journal records (usage.recorded events, summed). */
export function usageOfRun(events: readonly EngineEvent[]): Usage {
  const records: UsageRecord[] = [];
  for (const e of events) {
    if (e.type !== "usage.recorded") continue;
    const record = (e.data as { record?: UsageRecord } | undefined)?.record;
    if (record !== undefined) records.push(record);
  }
  return usageOfRows(records);
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The request as a summary line: the first line of the request, at most 200 characters. */
function requestLineOf(request: string): string {
  const first = request.split("\n")[0] ?? "";
  return first.length > 200 ? first.slice(0, 200) : first;
}

/** The summary of a run. `sessions` is read only when the run's models are not recorded in its run.created. */
export function summaryOf(run: ProjectRun, now: number): RunSummary {
  const { record } = run;
  const runDir = record.runDir;
  let cached: SessionRef[] | undefined;
  const sessions = (): SessionRef[] => (cached ??= sessionsOf(runDir));
  const models = modelsOf(record, sessions);
  const created = eventOf(record, "run.created");
  const createdMs = record.createdAt ?? record.lastEventAt ?? now;
  const live = record.process?.alive === true;
  const result = readJsonFile(path.join(runDir, "result.json"));
  const base = (created?.data as { base_branch?: unknown } | undefined)?.base_branch;
  const counts = countsOf(taskRowsOf(record));
  const endMs = live ? now : (record.lastEventAt ?? createdMs);
  const requestText = (created?.data as { prompt?: unknown } | undefined)?.prompt;
  return {
    ref: runRefOf(run.projectId, record.runId),
    project_id: run.projectId,
    project_name: run.project.name,
    run_id: record.runId,
    request: requestLineOf(typeof requestText === "string" ? requestText : ""),
    status: record.status,
    status_word: statusWordOf(record),
    live,
    planner: models.planner,
    worker: models.worker,
    started_at: isoOf(createdMs) ?? new Date(now).toISOString(),
    ended_at: live ? null : isoOf(record.lastEventAt),
    elapsed_ms: Math.max(0, endMs - createdMs),
    branch: typeof base === "string" ? `substrate/runs/${record.runId}` : null,
    merged: record.terminal && typeof result?.merged === "boolean" ? result.merged : null,
    usage: usageOfRun(record.events),
    tasks: { total: counts.passed + counts.running + counts.failed + counts.waiting + counts.skipped, passed: counts.passed, running: counts.running, failed: counts.failed, skipped: counts.skipped },
    pause_reason: record.status === "paused" ? (record.state.pause_reason ?? null) : null,
  };
}

function verifyStatusOf(verify: VerifyResult[] | undefined): TaskRowApi["verify"] {
  if (verify === undefined) return null;
  if (verify.length === 0) return "not_run";
  if (verify.some((v) => v.timed_out)) return "timed_out";
  if (verify.some((v) => v.exit_code !== 0)) return "failed";
  return "passed";
}

/** The task rows of a run, in plan order, with the attempt facts the UI shows. */
export function taskRowsApiOf(record: RunRecord, sessions: SessionRef[], now: number): TaskRowApi[] {
  const reports = attemptReportsOf(record.runDir);
  const lastTaskEvent = new Map<string, number>();
  for (const e of record.events) {
    const tid = (e.data as { task_id?: unknown } | undefined)?.task_id;
    if (typeof tid === "string") lastTaskEvent.set(tid, Date.parse(e.ts));
  }
  return taskRowsOf(record).map((row) => {
    const raw = record.state.tasks[row.id as TaskId] ?? record.state.repairs?.[row.id];
    const state = raw?.state ?? "PENDING";
    const latest = reports.filter((r) => r.task_id === row.id).at(-1);
    const started = row.started_at === null ? undefined : Date.parse(row.started_at);
    const endMs = TERMINAL_TASK_STATES.has(state) ? (lastTaskEvent.get(row.id) ?? now) : now;
    return {
      id: row.id,
      title: row.title ?? row.id,
      class: row.class ?? "",
      state,
      generation: row.generation,
      attempt: row.attempt,
      session_ids: sessions.filter((s) => s.task_id === row.id).map((s) => s.session_id),
      failure_class: raw?.failure_class ?? null,
      failure_message: raw?.failure_message ?? null,
      files_changed: latest?.report.files_changed ?? [],
      cost_usd: row.cost_usd,
      elapsed_ms: started === undefined ? 0 : Math.max(0, endMs - started),
      verify: verifyStatusOf(latest?.report.verify),
    };
  });
}

/** The integration verdict (the last integration event) and its repair attempts. */
export function integrationOf(events: readonly EngineEvent[]): IntegrationApi {
  let verdict: IntegrationApi["verdict"] = "pending";
  const repairs: IntegrationApi["repairs"] = [];
  for (const e of events) {
    switch (e.type) {
      case "integration.started":
        verdict = "verifying";
        break;
      case "integration.finished":
        verdict = (e.data as { passed?: unknown } | undefined)?.passed === true ? "passed" : "failed";
        break;
      case "integration.failed":
        verdict = "failed";
        break;
      case "integration.could_not_run":
        verdict = "could_not_run";
        break;
      case "integration.skipped":
        verdict = "skipped";
        break;
      case "integration.repair.finished": {
        const data = e.data as { attempt?: unknown; passed?: unknown };
        repairs.push({ attempt: Number(data.attempt ?? 0), outcome: data.passed === true ? "passed" : "failed", session_id: null });
        break;
      }
      default:
        break;
    }
  }
  return { verdict, verify: [], repairs };
}

/** The full detail of a run (RunDetail). */
export function detailOf(run: ProjectRun, now: number): RunDetail {
  const { record } = run;
  const runDir = record.runDir;
  const summary = summaryOf(run, now);
  const sessions = sessionsOf(runDir);
  const pausedWithQuestions = [...record.events].reverse().find(
    (e) => e.type === "run.paused" && Array.isArray((e.data as { questions?: unknown } | undefined)?.questions),
  );
  const questions = (pausedWithQuestions?.data as { questions?: { text?: unknown }[] } | undefined)?.questions ?? [];
  const pauseQuestion = summary.status === "paused" && questions.length > 0
    ? questions.map((q) => (typeof q.text === "string" ? q.text : "")).join("\n")
    : null;
  const result = readJsonFile(path.join(runDir, "result.json"));
  const verification = result?.verification;
  const note = result?.verification_note;
  const report = readTextFile(path.join(runDir, "REPORT.md")) ?? readTextFile(path.join(runDir, "summary.txt"));
  const plannerIds = new Set(sessions.filter((s) => s.role === "planner").map((s) => s.session_id));
  for (const e of record.events) {
    const id = (e.data as { planner_session_id?: unknown } | undefined)?.planner_session_id;
    if (typeof id === "string") plannerIds.add(id);
  }
  return {
    ...summary,
    request: requestOfRecord(record),
    pause_question: pauseQuestion,
    verification: verification === "passed" || verification === "failed" || verification === "skipped" || verification === "not_run" ? verification : null,
    verification_note: typeof note === "string" ? note : null,
    report_text: report ?? null,
    tasks: taskRowsApiOf(record, sessions, now),
    sessions,
    planner_session_ids: [...plannerIds],
    integration: integrationOf(record.events),
    artifacts: artifactIndexOf(runDir).map(artifactRefOf),
    chat_available: true,
  };
}

function requestOfRecord(record: RunRecord): string {
  const created = eventOf(record, "run.created");
  const prompt = (created?.data as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}


/** The project views (Project in the design): every registered project with its newest run and live count. */
export function projectViewsOf(env: NodeJS.ProcessEnv): {
  id: string;
  path: string;
  name: string;
  last_run_at: string | null;
  running_count: number;
}[] {
  const runs = projectRunsOf(env);
  return listProjects(env)
    .map((entry) => {
      const id = projectIdOf(entry.path);
      const mine = runs.filter((r) => r.projectId === id);
      const newest = mine.reduce<number | undefined>(
        (best, r) => (r.record.createdAt !== undefined && (best === undefined || r.record.createdAt > best) ? r.record.createdAt : best),
        undefined,
      );
      return {
        id,
        path: entry.path,
        name: entry.name,
        last_run_at: isoOf(newest),
        running_count: mine.filter((r) => r.record.process?.alive === true).length,
      };
    })
    .sort((a, b) => (b.last_run_at ?? "").localeCompare(a.last_run_at ?? "") || a.name.localeCompare(b.name));
}


/** The run statuses a list may filter by (docs/design/web-ui.md, 5.1). */
export const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "planned",
  "paused",
  "finished",
  "failed",
  "stopped",
  "interrupted",
  "cancelled",
];
