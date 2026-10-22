import fs from "node:fs";
import path from "node:path";

import type { BackendEvent } from "../contracts/index.js";
import type { TranscriptHeader } from "../store/transcript.js";
import { completeLinesOf } from "./tail.js";
import { usageOfRows, type Usage, type UsageRow } from "./usage.js";

// The transcripts of a run (docs/design/web-ui.md, 5.1 SessionRef and TranscriptLineOut, 6.3): one file per
// session, line 0 the header, then {ts, event} lines. The reader works on whole lines, so a torn last line
// (a write in progress) is left out until it is complete.

export type SessionRole = "planner" | "planner_chat" | "worker" | "repair";

export interface SessionRef {
  session_id: string;
  role: SessionRole;
  task_id: string | null;
  generation: number | null;
  attempt: number | null;
  backend: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  ok: boolean | null;
  usage: Usage | null;
}

export interface TranscriptLineOut {
  index: number;
  ts: string;
  header: HeaderLine | null;
  event: BackendEvent | null;
}

/** A transcript file of the run: its path, its session id and its parsed header. */
export interface TranscriptFile {
  file: string;
  session: string;
  header: HeaderLine;
}

const DIR = "transcripts";

/** The header line as the engine writes it: the store's header fields plus the time the session opened. */
export interface HeaderLine extends TranscriptHeader {
  started_at: string;
}

function parseHeader(line: string | undefined): HeaderLine | undefined {
  if (line === undefined) return undefined;
  try {
    const raw = JSON.parse(line) as Partial<TranscriptHeader> & { type?: unknown };
    if (raw.type !== "header" || typeof raw.session !== "string") return undefined;
    return raw as HeaderLine;
  } catch {
    return undefined;
  }
}

/** Every transcript file of the run whose header parses, keyed by the header's session id. */
export function transcriptFilesOf(runDir: string): TranscriptFile[] {
  const dir = path.join(runDir, DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const header = parseHeader(completeLinesOf(file)[0]);
    if (header !== undefined) files.push({ file, session: header.session, header });
  }
  return files;
}

/** The file of a session id (the harness id as the header names it), or undefined when the run has no such session. */
export function transcriptFileOf(runDir: string, session: string): TranscriptFile | undefined {
  return transcriptFilesOf(runDir).find((f) => f.session === session);
}

interface ParsedLine {
  ts: string;
  event: BackendEvent;
}

function parseEventLine(line: string): ParsedLine | undefined {
  try {
    const raw = JSON.parse(line) as { ts?: unknown; event?: unknown };
    if (typeof raw.ts !== "string" || typeof raw.event !== "object" || raw.event === null) return undefined;
    return { ts: raw.ts, event: raw.event as BackendEvent };
  } catch {
    return undefined;
  }
}

/** The session list of the run, one SessionRef per transcript, oldest first. */
export function sessionsOf(runDir: string): SessionRef[] {
  const sessions: SessionRef[] = [];
  for (const { file, header } of transcriptFilesOf(runDir)) {
    const lines = completeLinesOf(file);
    let endedAt: string | null = null;
    let ok: boolean | null = null;
    const usageRows: Usage[] = [];
    const records: UsageRow[] = [];
    for (const line of lines.slice(1)) {
      const parsed = parseEventLine(line);
      if (parsed === undefined) continue;
      if (parsed.event.type === "session.result") {
        endedAt = parsed.ts;
        ok = parsed.event.ok;
      }
      if (parsed.event.type === "usage") records.push(parsed.event.record);
    }
    if (records.length > 0) usageRows.push(usageOfRows(records));
    sessions.push({
      session_id: header.session,
      role: header.role,
      task_id: header.task_id ?? null,
      generation: header.generation ?? null,
      attempt: header.attempt ?? null,
      backend: header.backend,
      model: header.model,
      started_at: header.started_at,
      ended_at: endedAt,
      ok,
      usage: usageRows[0] ?? null,
    });
  }
  return sessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/**
 * The lines of a session with index greater than `after` (index 0 is the header), at most `limit`. `complete` is true
 * once the session has a session.result line, or when the run is not live and the file is closed (the caller says so).
 */
export function transcriptSliceOf(
  file: string,
  after: number,
  limit: number,
  runIsLive: boolean,
): { lines: TranscriptLineOut[]; next: number; complete: boolean } {
  const raw = completeLinesOf(file);
  const lines: TranscriptLineOut[] = [];
  let hasResult = false;
  raw.forEach((line, index) => {
    if (index === 0) {
      const header = parseHeader(line);
      if (header !== undefined && index > after && lines.length < limit) {
        lines.push({ index, ts: header.started_at, header, event: null });
      }
      return;
    }
    const parsed = parseEventLine(line);
    if (parsed === undefined) return;
    if (parsed.event.type === "session.result") hasResult = true;
    if (index > after && lines.length < limit) {
      lines.push({ index, ts: parsed.ts, header: null, event: parsed.event });
    }
  });
  const next = lines.length > 0 ? lines[lines.length - 1].index : after;
  const lastIndex = raw.length - 1;
  return { lines, next, complete: hasResult || (!runIsLive && next >= lastIndex) };
}

/** One raw line of a transcript file as the API serves it (index 0 is the header), or undefined for a torn or unknown line. */
export function transcriptLineOut(index: number, line: string): TranscriptLineOut | undefined {
  if (index === 0) {
    const header = parseHeader(line);
    return header === undefined ? undefined : { index, ts: header.started_at, header, event: null };
  }
  const parsed = parseEventLine(line);
  return parsed === undefined ? undefined : { index, ts: parsed.ts, header: null, event: parsed.event };
}
