import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { parseChatLine } from "../observe/chat-view.js";
import { LineTailer, completeLinesOf } from "../observe/tail.js";
import { projectRunsOf, projectViewsOf, runOfRef, summaryOf, taskRowsApiOf } from "../observe/runs-view.js";
import { sessionsOf, transcriptLineOut } from "../observe/transcripts.js";
import { log } from "../util/log.js";

// Server-Sent Events for the web UI (docs/design/web-ui.md, 5.2): the per-job stream (`engine`, `transcript`, `chat`,
// `state`) and the service stream (`run`, `project`). A stream polls the run's files every POLL_MS and also wakes
// early when fs.watch reports a change in the run directory. The watchers are shared per directory and removed
// when the last stream on that directory closes; a stream keeps no file open between polls.

const POLL_MS = 500;
const PING_MS = 15000;
/** A stream of a job that is not live closes after this long without a new line or change. */
const IDLE_CLOSE_MS = 5000;
/** The run's summary and task rows are recomputed at least this often (a liveness change has no file write). */
const STATE_EVERY_MS = 2000;
/** The service stream recomputes every run this often. */
const GLOBAL_POLL_MS = 1000;
const WAKE_DELAY_MS = 30;

type Listener = () => void;
const directoryWatchers = new Map<string, { watcher: fs.FSWatcher | undefined; listeners: Set<Listener> }>();

/** Calls `listener` when something in `dir` changes. Returns the function that unsubscribes. */
function watchDirectory(dir: string, listener: Listener): () => void {
  let entry = directoryWatchers.get(dir);
  if (entry === undefined) {
    const created: { watcher: fs.FSWatcher | undefined; listeners: Set<Listener> } = { watcher: undefined, listeners: new Set() };
    try {
      created.watcher = fs.watch(dir, () => {
        for (const fn of created.listeners) fn();
      });
      created.watcher.on("error", () => {
        // The polling loop still sees every change.
      });
    } catch {
      created.watcher = undefined;
    }
    directoryWatchers.set(dir, created);
    entry = created;
  }
  const current = entry;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.watcher?.close();
      if (directoryWatchers.get(dir) === current) directoryWatchers.delete(dir);
    }
  };
}

/** The headers of an event stream, and the retry hint a client reconnects with. */
function openStream(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
}

function send(res: ServerResponse, event: string, data: unknown, id?: number): void {
  if (res.writableEnded || res.destroyed) return;
  const head = id === undefined ? "" : `id: ${id}\n`;
  res.write(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The Last-Event-ID of a reconnect as a number; 0 (everything) when absent or not a number. */
function lastEventIdOf(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = value === undefined ? NaN : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Where a stream ends: its close function, kept by the server so that it can end every stream on shutdown. */
export type StreamRegistry = Set<() => void>;

function startTimers(
  res: ServerResponse,
  registry: StreamRegistry,
  pollMs: number,
  onTick: () => void,
  closeOnIdle: () => void,
): {
  close(): void;
  wake(): void;
} {
  let closed = false;
  let wakeTimer: NodeJS.Timeout | undefined;
  const poll = setInterval(onTick, pollMs);
  const ping = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, PING_MS);
  const idle = setInterval(closeOnIdle, 1000);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(ping);
    clearInterval(idle);
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
    registry.delete(close);
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const wake = (): void => {
    if (closed || wakeTimer !== undefined) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      onTick();
    }, WAKE_DELAY_MS);
  };
  registry.add(close);
  res.on("close", close);
  return { close, wake };
}

/** Lists a run's transcript files; empty when the run has none yet. */
function transcriptFilesIn(runDir: string): string[] {
  try {
    return fs.readdirSync(path.join(runDir, "transcripts")).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(runDir, "transcripts", n));
  } catch {
    return [];
  }
}

/** The stream of one job (GET /api/runs/:ref/stream). The caller has checked that the run exists. */
export function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
  ref: string,
  registry: StreamRegistry,
): void {
  const initial = runOfRef(env, ref);
  if (initial === undefined) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "not_found", message: `no run ${ref}` } }));
    return;
  }
  const runDir = initial.record.runDir;
  openStream(res);

  let lastSeq = lastEventIdOf(req);
  const engine = new LineTailer(path.join(runDir, "events.jsonl"));
  const chat = new LineTailer(path.join(runDir, "chat.jsonl"));
  chat.skipToEnd();

  interface TranscriptCursor {
    tailer: LineTailer;
    seen: number;
    session: string | undefined;
  }
  const transcripts = new Map<string, TranscriptCursor>();
  // Transcripts that exist at connect start at their end: the client reads their earlier lines from the API.
  for (const file of transcriptFilesIn(runDir)) {
    const tailer = new LineTailer(file);
    tailer.skipToEnd();
    const lines = completeLinesOf(file);
    transcripts.set(file, { tailer, seen: lines.length, session: transcriptLineOut(0, lines[0] ?? "")?.header?.session });
  }

  const sentRun = new Map<string, string>();
  const sentTask = new Map<string, string>();
  let live = initial.record.process?.alive === true;
  let lastState = 0;
  let lastActivity = Date.now();

  const stateTick = (now: number): void => {
    const current = runOfRef(env, ref);
    if (current === undefined) return;
    const summary = summaryOf(current, now);
    live = summary.live;
    const tasks = taskRowsApiOf(current.record, sessionsOf(runDir), now);
    const run: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(summary)) {
      const json = JSON.stringify(value);
      if (sentRun.get(key) !== json) {
        sentRun.set(key, json);
        run[key] = value;
      }
    }
    const changedTasks = tasks.filter((t) => {
      const json = JSON.stringify(t);
      if (sentTask.get(t.id) === json) return false;
      sentTask.set(t.id, json);
      return true;
    });
    if (Object.keys(run).length > 0 || changedTasks.length > 0) {
      send(res, "state", changedTasks.length > 0 ? { ref, run, tasks: changedTasks } : { ref, run });
      lastActivity = now;
    }
  };

  const onTick = (): void => {
    const now = Date.now();
    let engineChanged = false;
    for (const line of engine.read()) {
      let event: { seq?: unknown };
      try {
        event = JSON.parse(line) as { seq?: unknown };
      } catch {
        continue; // a line that does not parse is skipped
      }
      if (typeof event.seq !== "number" || event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      send(res, "engine", event, event.seq);
      engineChanged = true;
    }
    let activity = engineChanged;
    for (const file of transcriptFilesIn(runDir)) {
      let cursor = transcripts.get(file);
      if (cursor === undefined) {
        cursor = { tailer: new LineTailer(file), seen: 0, session: undefined };
        transcripts.set(file, cursor);
      }
      for (const line of cursor.tailer.read()) {
        const index = cursor.seen;
        cursor.seen += 1;
        const out = transcriptLineOut(index, line);
        if (out === undefined) continue;
        if (out.header !== null) cursor.session = out.header.session;
        if (cursor.session === undefined) continue;
        send(res, "transcript", { session: cursor.session, line: out });
        activity = true;
      }
    }
    for (const line of chat.read()) {
      const message = parseChatLine(line);
      if (message === undefined) continue;
      send(res, "chat", message);
      activity = true;
    }
    if (engineChanged || now - lastState >= STATE_EVERY_MS) {
      lastState = now;
      try {
        const before = sentRun.size;
        stateTick(now);
        if (sentRun.size !== before) activity = true;
      } catch (err) {
        log.warn(`web stream of ${ref} could not read the run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (activity) lastActivity = now;
  };

  const timers = startTimers(res, registry, POLL_MS, onTick, () => {
    // A job that is not live is done: the stream ends after a quiet spell, and the client reads the rest from the API.
    if (!live && Date.now() - lastActivity >= IDLE_CLOSE_MS) timers.close();
  });
  const unwatchRun = watchDirectory(runDir, timers.wake);
  const unwatchTranscripts = fs.existsSync(path.join(runDir, "transcripts"))
    ? watchDirectory(path.join(runDir, "transcripts"), timers.wake)
    : () => undefined;
  res.on("close", () => {
    unwatchRun();
    unwatchTranscripts();
  });
  onTick();
}

/** The service stream (GET /api/stream): every run's summary when it first appears or changes, and each project's view. */
export function streamGlobal(res: ServerResponse, env: NodeJS.ProcessEnv, registry: StreamRegistry): void {
  openStream(res);
  const sentRun = new Map<string, string>();
  const sentProject = new Map<string, string>();
  const onTick = (): void => {
    const now = Date.now();
    try {
      for (const row of projectRunsOf(env)) {
        const summary = summaryOf(row, now);
        const json = JSON.stringify(summary);
        if (sentRun.get(summary.ref) !== json) {
          sentRun.set(summary.ref, json);
          send(res, "run", summary);
        }
      }
      for (const project of projectViewsOf(env)) {
        const json = JSON.stringify(project);
        if (sentProject.get(project.id) !== json) {
          sentProject.set(project.id, json);
          send(res, "project", project);
        }
      }
    } catch (err) {
      log.warn(`web service stream could not read the projects: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  startTimers(res, registry, GLOBAL_POLL_MS, onTick, () => undefined);
  onTick();
}
