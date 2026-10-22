import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineEvent } from "../../../src/contracts/index.js";
import { chatPackOf, detectAmendment, releaseTurnLock, takeTurnLock } from "../../../src/roles/planner-chat.js";

// The planner chat turn's pure parts (docs/design/web-ui.md, 7.2): the context pack, the amendment directory the
// planner left, and the chat-turn lock (one turn per run; a stale lock is taken over).

const dirs: string[] = [];
function tempRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-chat-unit-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function eventsOf(count: number): EngineEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    v: 1 as const,
    seq: i + 1,
    ts: "2026-10-22T10:00:00.000Z",
    run_id: "r_UNIT",
    type: i % 2 === 0 ? "task.started" : "task.passed",
    data: { task_id: "T1", n: i },
  }));
}

describe("chatPackOf (the context pack of a chat turn)", () => {
  it("gives the planner the last 30 events, the last 10 messages and the last 3 failures, and caps a long manifest", () => {
    const events = eventsOf(40);
    const history = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}`, role: "user", status: "answered", text: `message ${i + 1}` }));
    const failures = [1, 2, 3, 4].map((i) => ({ task_id: `T${i}`, failure_class: "verify", detail: `failure ${i}` }));
    const pack = chatPackOf({
      charter: "Keep it small.",
      request: "make a snake game",
      runState: "failed; not live",
      amendmentDir: "amendments/c3",
      manifest: "x".repeat(9000),
      tasks: [{ id: "T1", title: "Board", state: "PASSED" }],
      failures,
      report: "",
      events,
      history,
      message: "Add a task.",
    });

    expect(pack.charter).toBe("Keep it small.");
    expect(pack.amendment_dir).toBe("amendments/c3");
    expect(pack.task_states).toBe("- T1 (Board): PASSED");
    expect(pack.message).toBe("Add a task.");
    expect(pack.manifest).toContain("[truncated:");

    const eventLines = pack.events.split("\n");
    expect(eventLines).toHaveLength(30);
    expect(eventLines[0].startsWith("11 ")).toBe(true);
    expect(eventLines.at(-1)?.startsWith("40 ")).toBe(true);

    expect(pack.history.split("\n")).toHaveLength(10);
    expect(pack.history.startsWith("c3 user")).toBe(true);

    const failureLines = pack.failures.split("\n");
    expect(failureLines).toHaveLength(3);
    expect(pack.failures).not.toContain("failure 1");
    expect(pack.failures).toContain("failure 4");

    // An empty section is an empty value; the template renders it as (none).
    expect(pack.report).toBe("");
  });
});

describe("detectAmendment", () => {
  it("finds a manifest in amendments/<chat id>/ and nothing else", () => {
    const runDir = tempRunDir();
    expect(detectAmendment(runDir, "c1")).toBeUndefined();

    mkdirSync(join(runDir, "amendments", "c2"), { recursive: true });
    writeFileSync(join(runDir, "amendments", "c2", "manifest.yaml"), "version: 1\n", "utf8");
    expect(detectAmendment(runDir, "c2")).toBe("amendments/c2");
    expect(detectAmendment(runDir, "c3")).toBeUndefined();

    // A chat id is only "c<n>": anything else is never read as a path.
    expect(detectAmendment(runDir, "../c2")).toBeUndefined();
  });
});

describe("the chat-turn lock", () => {
  it("is taken once, refused while its holder is alive, taken over when stale, and released by its holder", () => {
    const runDir = tempRunDir();
    const me = 4242;

    expect(takeTurnLock(runDir, me, () => true)).toBe(true);
    expect(takeTurnLock(runDir, 5151, () => true)).toBe(false);
    releaseTurnLock(runDir, 5151);
    expect(existsSync(join(runDir, "chat-turn.lock"))).toBe(true);

    // The holder is gone: its lock is stale and the next turn takes it.
    expect(takeTurnLock(runDir, 5151, () => false)).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir, "chat-turn.lock"), "utf8")).pid).toBe(5151);

    releaseTurnLock(runDir, 5151);
    expect(existsSync(join(runDir, "chat-turn.lock"))).toBe(false);
  });
});
