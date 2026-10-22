// The in-memory model of the client: the projects, the job summaries (every project), and one job record per job
// the page has opened (its detail, task rows, sessions, transcripts, engine events and chat). Stream and API data go
// in here; the views read from here and redraw on the events this module emits. Applying the same event twice is
// harmless: engine events are keyed by seq and transcript lines by index.

import { itemsOfLine, newCursor } from "./items.js";
import { storeGet, storeSet } from "./util.js";

export const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, fn) {
  bus.addEventListener(name, (e) => fn(e.detail));
}

export const state = {
  /** The global stream: connecting, open, or down (retrying). */
  conn: "connecting",
  projects: [],
  projectsError: null,
  runs: new Map(),
  runsError: null,
  /** The project the lists show; null means every project. Remembered when storage allows. */
  project: storeGet("substrate.ui.project") || null,
  pastLimit: 50,
  /** { ref, actor } where actor is { kind, id? }. */
  selected: null,
  jobs: new Map(),
  usage: null,
  usageError: null,
  /** False once the service answers the chat POST with 404 or 501 (docs/design/web-ui.md, 7). */
  chatAvailable: true,
};

export function setProject(id) {
  state.project = id || null;
  storeSet("substrate.ui.project", state.project ?? "");
  emit("runs");
}

export function jobOf(ref) {
  let job = state.jobs.get(ref);
  if (job === undefined) {
    job = {
      ref,
      detail: null,
      error: null,
      tasks: new Map(),
      sessions: new Map(),
      cursors: new Map(),
      events: [],
      lastSeq: 0,
      chat: new Map(),
      chatError: null,
      streamState: "idle",
      catchingUp: false,
      again: false,
      detailAt: 0,
    };
    state.jobs.set(ref, job);
  }
  return job;
}

/** Whether a job is live: the summary's flag, else the detail's. */
export function isLive(ref) {
  const summary = state.runs.get(ref);
  if (summary !== undefined) return summary.live === true;
  return state.jobs.get(ref)?.detail?.live === true;
}

/** The fields a summary can change on a detail, without the detail's own task list or request text. */
function summaryFieldsOf(source) {
  const { tasks, request, sessions, integration, artifacts, ...rest } = source;
  return rest;
}

/** Replaces the list of job summaries (the first load and each whole refresh). */
export function setRuns(list) {
  state.runs = new Map(list.map((row) => [row.ref, row]));
  state.runsError = null;
  emit("runs");
}

/** One job summary, from the service stream or a `state` patch. Updates the job detail's scalar fields too. */
export function putRun(summary) {
  const prev = state.runs.get(summary.ref);
  state.runs.set(summary.ref, { ...prev, ...summary });
  const job = state.jobs.get(summary.ref);
  if (job?.detail) Object.assign(job.detail, summaryFieldsOf(summary));
  emit("runs");
  if (job) emit("job", { ref: summary.ref });
}

/** A `state` patch from the job stream: changed scalar fields, and the task rows that changed. */
export function applyStatePatch(ref, patch) {
  if (patch.run && Object.keys(patch.run).length > 0) {
    const scalar = { ...patch.run };
    const counts = scalar.tasks;
    delete scalar.tasks;
    const summary = { ref, ...scalar };
    if (counts !== undefined) summary.tasks = counts;
    putRun(summary);
  }
  const job = jobOf(ref);
  if (Array.isArray(patch.tasks)) {
    for (const row of patch.tasks) job.tasks.set(row.id, row);
  }
  emit("job", { ref });
}

/** A full job detail from GET /api/runs/:ref. */
export function setDetail(ref, detail) {
  const job = jobOf(ref);
  job.detail = detail;
  job.error = null;
  job.detailAt = Date.now();
  job.tasks = new Map(detail.tasks.map((row) => [row.id, row]));
  for (const session of detail.sessions) {
    job.sessions.set(session.session_id, { ...job.sessions.get(session.session_id), ...session });
  }
  putRun(summaryFieldsOf(detail));
}

/** One engine event from the stream or the engine endpoint. Events are kept in seq order and each seq once. */
export function applyEngine(ref, event) {
  const job = jobOf(ref);
  if (typeof event.seq !== "number" || event.seq <= job.lastSeq) return false;
  job.events.push(event);
  job.lastSeq = event.seq;
  emit("engine", { ref });
  return true;
}

/** One transcript line of a session. Index 0 is the header, which also names the session. */
export function applyTranscript(ref, session, line) {
  const job = jobOf(ref);
  let cursor = job.cursors.get(session);
  if (cursor === undefined) {
    cursor = newCursor();
    job.cursors.set(session, cursor);
  }
  if (line.index <= cursor.lastIndex) return;
  cursor.lastIndex = line.index;
  const items = itemsOfLine(line, cursor);
  for (const item of items) cursor.items.push(item);
  if (line.header) {
    const h = line.header;
    job.sessions.set(session, {
      ...job.sessions.get(session),
      session_id: session,
      role: h.role,
      task_id: h.task_id ?? null,
      generation: h.generation ?? null,
      attempt: h.attempt ?? null,
      backend: h.backend,
      model: h.model,
      started_at: h.started_at,
      ended_at: null,
      ok: null,
    });
  }
  if (cursor.ended) {
    const known = job.sessions.get(session);
    if (known && known.ended_at === null) job.sessions.set(session, { ...known, ended_at: line.ts, ok: cursor.ok });
  }
  emit("transcript", { ref, session });
}

export function setChat(ref, messages) {
  const job = jobOf(ref);
  job.chat = new Map(messages.map((m) => [m.id, m]));
  job.chatError = null;
  emit("chat", { ref });
}

export function applyChat(ref, message) {
  const job = jobOf(ref);
  job.chat.set(message.id, message);
  emit("chat", { ref });
}

/** The sessions an actor shows, oldest first. A task shows its latest attempt; a planner shows every planner session. */
export function sessionsFor(job, actor) {
  const all = [...job.sessions.values()];
  const byStart = (a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "");
  switch (actor?.kind) {
    case "planner":
      return all.filter((s) => s.role === "planner" || s.role === "planner_chat").sort(byStart);
    case "repair":
      return all.filter((s) => s.role === "repair").sort(byStart);
    case "task": {
      const attempts = attemptsOf(job, actor.id);
      return attempts.length > 0 ? [attempts[attempts.length - 1]] : [];
    }
    case "session":
      return all.filter((s) => s.session_id === actor.id);
    default:
      return [];
  }
}

/** The worker attempts of a task, oldest first (by generation, then attempt). */
export function attemptsOf(job, taskId) {
  return [...job.sessions.values()]
    .filter((s) => s.role === "worker" && s.task_id === taskId)
    .sort((a, b) => (a.generation ?? 0) - (b.generation ?? 0) || (a.attempt ?? 0) - (b.attempt ?? 0));
}

/** The actor's path in the URL hash and its label. */
export function actorPath(actor) {
  if (!actor) return "";
  switch (actor.kind) {
    case "task":
      return `task/${actor.id}`;
    case "session":
      return `session/${actor.id}`;
    default:
      return actor.kind;
  }
}

/** The actor a URL hash path names, or null for an unknown path. */
export function actorOfPath(path) {
  if (path === "planner" || path === "engine" || path === "integration" || path === "repair") return { kind: path };
  const m = /^(task|session)\/(.+)$/.exec(path ?? "");
  if (m) return { kind: m[1], id: decodeURIComponent(m[2]) };
  return null;
}
