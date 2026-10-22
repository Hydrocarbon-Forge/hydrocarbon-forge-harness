// Loads a job from the API and brings it up to date. The job stream sends only what happens after it connects, so
// every (re)connection starts with a catch-up: the detail, the engine events after the last seq, each transcript after
// the last index, and the chat. Catch-up runs one at a time per job; a request that arrives meanwhile runs after it.

import { api } from "./api.js";
import {
  applyEngine,
  applyTranscript,
  emit,
  jobOf,
  putRun,
  setChat,
  setDetail,
  state,
} from "./store.js";
import { errorMessage } from "./util.js";

const PAGE = 500;
const DETAIL_GAP_MS = 2500;
const scheduled = new Map();

export async function catchUp(ref) {
  const job = jobOf(ref);
  if (job.catchingUp) {
    job.again = true;
    return;
  }
  job.catchingUp = true;
  try {
    setDetail(ref, await api.run(ref));
    await loadEngine(ref);
    for (const session of job.detail.sessions.map((s) => s.session_id)) {
      await loadTranscript(ref, session);
    }
    setChat(ref, await api.chat(ref));
    job.error = null;
  } catch (err) {
    job.error = errorMessage(err);
  } finally {
    job.catchingUp = false;
    emit("job", { ref });
    if (job.again) {
      job.again = false;
      await catchUp(ref);
    }
  }
}

async function loadEngine(ref) {
  const job = jobOf(ref);
  let after = job.lastSeq;
  for (;;) {
    const slice = await api.engine(ref, after, PAGE);
    for (const event of slice.events) applyEngine(ref, event);
    if (slice.events.length < PAGE) return;
    after = slice.next;
  }
}

async function loadTranscript(ref, session) {
  const job = jobOf(ref);
  const cursor = job.cursors.get(session);
  if (cursor && cursor.loaded && cursor.ended) return;
  let after = cursor ? cursor.lastIndex : -1;
  for (;;) {
    const slice = await api.transcript(ref, session, after, PAGE);
    for (const line of slice.lines) applyTranscript(ref, session, line);
    if (slice.lines.length > 0) after = slice.next;
    if (slice.lines.length < PAGE) break;
  }
  const done = jobOf(ref).cursors.get(session);
  if (done) done.loaded = true;
}

/** Schedules a catch-up of a job no more often than DETAIL_GAP_MS (a busy run sends many state events). */
export function scheduleCatchUp(ref) {
  if (scheduled.has(ref)) return;
  const wait = Math.max(0, DETAIL_GAP_MS - (Date.now() - jobOf(ref).detailAt));
  scheduled.set(
    ref,
    setTimeout(() => {
      scheduled.delete(ref);
      void catchUp(ref);
    }, wait),
  );
}

/** The project list and the job summaries, from the API (the service stream keeps them current after this). */
export async function loadLists() {
  try {
    state.projects = await api.projects();
    state.projectsError = null;
  } catch (err) {
    state.projectsError = errorMessage(err);
  }
  try {
    const rows = await api.runs(200);
    for (const row of rows) putRun(row);
    state.runsError = null;
  } catch (err) {
    state.runsError = errorMessage(err);
  }
  emit("runs");
}

/** Today's total cost, from the usage report. */
export async function loadUsage() {
  const since = new Date().toISOString().slice(0, 10);
  try {
    state.usage = (await api.usage(since)).total;
    state.usageError = null;
  } catch (err) {
    state.usageError = errorMessage(err);
  }
  emit("status");
}
