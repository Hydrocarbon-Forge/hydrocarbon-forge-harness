import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { BackendEvent } from "../../../src/contracts/index.js";
import { openTranscript, teeTranscript, TRANSCRIPT_FIELD_CAP } from "../../../src/store/transcript.js";

const HEADER = {
  session: "sess-1",
  role: "worker" as const,
  task_id: "T1",
  generation: 1,
  attempt: 1,
  backend: "claude" as const,
  model: "haiku",
};

function linesOf(file: string): any[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("transcript writer (web UI section 6.3)", () => {
  it("writes the header as line 0 and one {ts, event} line per event, in order", () => {
    const runDir = mkdtempSync(join(tmpdir(), "substrate-transcript-"));
    const writer = openTranscript(runDir, HEADER);
    writer.write({ type: "assistant.text", text: "first" });
    writer.write({ type: "tool.call", id: "c1", name: "Edit", input_summary: "src/a.txt" });
    writer.close();

    const lines = linesOf(join(runDir, "transcripts", "sess-1.jsonl"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "header", v: 1, session: "sess-1", role: "worker", task_id: "T1", generation: 1, attempt: 1, backend: "claude", model: "haiku" });
    expect(typeof lines[0].started_at).toBe("string");
    expect(typeof lines[1].ts).toBe("string");
    expect(lines[1].event).toEqual({ type: "assistant.text", text: "first" });
    expect(lines[2].event.name).toBe("Edit");
  });

  it("caps a long text field with a marker and leaves a short one alone", () => {
    const runDir = mkdtempSync(join(tmpdir(), "substrate-transcript-"));
    const writer = openTranscript(runDir, HEADER);
    const long = "x".repeat(TRANSCRIPT_FIELD_CAP + 100);
    writer.write({ type: "assistant.text", text: long });
    writer.write({ type: "assistant.text", text: "short" });

    const lines = linesOf(join(runDir, "transcripts", "sess-1.jsonl"));
    const capped = lines[1].event.text as string;
    expect(capped.startsWith("x".repeat(TRANSCRIPT_FIELD_CAP))).toBe(true);
    expect(capped).toContain("[truncated: 100 more characters]");
    expect(lines[2].event.text).toBe("short");
  });

  it("never throws when the run directory cannot hold a transcript", () => {
    const base = mkdtempSync(join(tmpdir(), "substrate-transcript-"));
    const blocker = join(base, "not-a-directory");
    writeFileSync(blocker, "a file where the run directory should be\n", "utf8");

    expect(() => {
      const writer = openTranscript(join(blocker, "run"), HEADER);
      writer.write({ type: "assistant.text", text: "lost" });
      writer.close();
    }).not.toThrow();
  });

  it("the tee passes every event through and records it under the session id the harness reports", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "substrate-transcript-"));
    mkdirSync(join(runDir, "transcripts"), { recursive: true });
    const events: BackendEvent[] = [
      { type: "session.started", session_id: "sess-tee" },
      { type: "assistant.text", text: "hello" },
    ];
    async function* source(): AsyncGenerator<BackendEvent> {
      for (const event of events) yield event;
    }

    const seen: BackendEvent[] = [];
    for await (const event of teeTranscript(source(), runDir, { ...HEADER, role: "planner", task_id: null, generation: null })) {
      seen.push(event);
    }

    expect(seen).toEqual(events);
    const lines = linesOf(join(runDir, "transcripts", "sess-tee.jsonl"));
    expect(lines[0]).toMatchObject({ type: "header", session: "sess-tee", role: "planner", task_id: null });
    expect(lines[1].event).toEqual({ type: "session.started", session_id: "sess-tee" });
    expect(lines[2].event).toEqual({ type: "assistant.text", text: "hello" });
  });
});
