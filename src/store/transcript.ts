import fs from "node:fs";
import path from "node:path";

import type { BackendEvent } from "../contracts/index.js";

// The transcript of one harness session, read by the web UI (docs/design/web-ui.md, sections 5.1 and 6.3).
// Each session gets runs/<id>/transcripts/<session>.jsonl: line 0 is the header, every following line is
// {"ts", "event"} with the BackendEvent exactly as the adapter streamed it (long text fields capped). Writes
// are synchronous appends, so the lines keep the order the engine saw them. A file that cannot be written
// disables its transcript for the rest of the session and never throws into the engine.

/** Cap for one text field of an event (assistant text, tool input and output, final text, messages). */
export const TRANSCRIPT_FIELD_CAP = 8 * 1024;

export type TranscriptRole = "planner" | "planner_chat" | "worker" | "repair";

/** What the engine knows about a session before its harness id is known. */
export interface TranscriptMeta {
  role: TranscriptRole;
  task_id: string | null;
  generation: number | null;
  attempt: number | null;
  backend: string;
  model: string;
}

/** The header line (line 0) of a transcript file. */
export interface TranscriptHeader extends TranscriptMeta {
  session: string;
}

export interface TranscriptWriter {
  write(event: BackendEvent): void;
  close(): void;
}

/** Keeps the first `cap` characters of a text and says how many were dropped. */
export function capField(text: string, cap: number = TRANSCRIPT_FIELD_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[truncated: ${text.length - cap} more characters]`;
}

function capEvent(event: BackendEvent): BackendEvent {
  switch (event.type) {
    case "assistant.text":
      return { ...event, text: capField(event.text) };
    case "tool.call":
      return { ...event, input_summary: capField(event.input_summary) };
    case "tool.result":
      return { ...event, output_summary: capField(event.output_summary) };
    case "permission.denied":
      return event.reason === undefined ? event : { ...event, reason: capField(event.reason) };
    case "error":
      return { ...event, message: capField(event.message) };
    case "session.result":
      return { ...event, final_text: capField(event.final_text) };
    case "subagent": {
      const json = JSON.stringify(event.raw) ?? "";
      return json.length <= TRANSCRIPT_FIELD_CAP ? event : { ...event, raw: { truncated: capField(json) } };
    }
    default:
      return event;
  }
}

/** A session id is a harness id; it names the file, so anything outside a plain filename is replaced. */
function fileNameOf(session: string): string {
  return `${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`;
}

/**
 * Opens the transcript of one session under the run directory. The header is written when the file is
 * created, so a resumed session (the same id, a later spawn) appends its events to the same file. Any I/O
 * error turns the writer into a no-op; nothing is thrown.
 */
export function openTranscript(runDir: string, header: TranscriptHeader): TranscriptWriter {
  let file: string | undefined;
  try {
    const dir = path.join(runDir, "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, fileNameOf(header.session));
    if (!fs.existsSync(file)) {
      const { session, ...rest } = header;
      const line = { type: "header", v: 1, session, ...rest, started_at: new Date().toISOString() };
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
    }
  } catch {
    file = undefined;
  }

  return {
    write(event: BackendEvent): void {
      if (file === undefined) return;
      try {
        fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event: capEvent(event) })}\n`, "utf8");
      } catch {
        file = undefined;
      }
    },
    close(): void {
      file = undefined;
    },
  };
}

/**
 * Passes a session's events through unchanged and writes them to its transcript. The transcript opens when
 * the harness reports its session id (session.started), so the header carries the real id. Every event loop
 * that consumes a harness session wraps its `handle.events` with this, so the three adapters are recorded alike.
 */
export async function* teeTranscript(
  events: AsyncIterable<BackendEvent>,
  runDir: string,
  meta: TranscriptMeta,
): AsyncGenerator<BackendEvent> {
  let writer: TranscriptWriter | undefined;
  try {
    for await (const event of events) {
      if (writer === undefined && event.type === "session.started" && event.session_id) {
        writer = openTranscript(runDir, { ...meta, session: event.session_id });
      }
      writer?.write(event);
      yield event;
    }
  } finally {
    writer?.close();
  }
}
