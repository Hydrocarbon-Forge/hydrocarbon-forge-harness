import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { EngineEvent, Settings } from "../../../src/contracts/index.js";
import { diffAmendment, drainInbox } from "../../../src/engine/amendment.js";
import { reduce, type EngineState } from "../../../src/engine/reducer.js";
import { reopenData } from "../../../src/engine/engine.js";

// W5a (docs/design/web-ui.md, 7.4): an amendment is diffed against the run's tasks by id; a task whose work has
// started is never changed; a dropped task is abandoned and stays abandoned through a reopen.

const RUN = "r_AMENDTEST00000";
let seq = 0;
function ev(type: string, data: Record<string, unknown> = {}): EngineEvent {
  seq += 1;
  return { v: 1, seq, ts: "2026-10-22T00:00:00.000Z", run_id: RUN, type, data } as unknown as EngineEvent;
}

describe("W5a: an amendment diff is by task id, and started work is never changed", () => {
  it("reports added, changed, dropped and kept_started, and does not change a started task", () => {
    const diff = diffAmendment(
      [
        { id: "T1", text: "spec one", state: "MERGED" },
        { id: "T2", text: "spec two", state: "PENDING" },
        { id: "T3", text: "spec three", state: "PENDING" },
        { id: "T4", text: "spec four", state: "RUNNING" },
      ],
      [
        { id: "T1", text: "spec one, edited" },
        { id: "T2", text: "spec two, edited" },
        { id: "T4", text: "spec four, edited" },
        { id: "T5", text: "spec five" },
      ]
    );
    expect(diff).toEqual({
      added: ["T5"],
      changed: ["T2"],
      dropped: ["T3"],
      kept_started: ["T1", "T4"],
    });
  });
});

describe("W5a: an applied amendment changes the task set through the reducer, and a replay agrees", () => {
  function start(): EngineState {
    return {
      run_id: RUN as EngineState["run_id"],
      state: "EXECUTING",
      tasks: {
        T1: { id: "T1", state: "MERGED", generation: 1, attempt: 1, depends_on: [], write: ["src/a.txt"], create: [] },
        T2: { id: "T2", state: "PENDING", generation: 1, attempt: 1, depends_on: ["T1"], write: ["src/b.txt"], create: [] },
        T3: { id: "T3", state: "PENDING", generation: 1, attempt: 1, depends_on: ["T2"], write: ["src/c.txt"], create: [] },
      },
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };
  }

  it("adds pending tasks, changes a pending one, abandons a dropped one, and a reopen keeps it abandoned", () => {
    seq = 0;
    const applied = ev("run.amended", {
      chat_id: "c1",
      outcome: "applied",
      applied_at: "live",
      added: ["T4"],
      changed: ["T2"],
      dropped: ["T3"],
      kept_started: [],
      warning_count: 0,
      tasks: [
        { id: "T4", depends_on: ["T1"], write: ["src/d.txt"], create: [] },
        { id: "T2", depends_on: [], write: ["src/b2.txt"], create: [] },
      ],
    });
    const after = reduce(start(), applied);
    expect(after.tasks.T4).toMatchObject({ state: "PENDING", depends_on: ["T1"], write: ["src/d.txt"] });
    expect(after.tasks.T2).toMatchObject({ state: "PENDING", depends_on: [], write: ["src/b2.txt"] });
    expect(after.tasks.T3).toMatchObject({ state: "ABANDONED", dropped: true });

    // A reopen (R10.4) returns skipped dependents to the queue, but never a dropped task.
    const reopened = reduce(after, ev("run.reopened", { reason: "tasks", failed_tasks: [], skipped_tasks: [], kept_tasks: ["T1"] }));
    expect(reopened.tasks.T3.state).toBe("ABANDONED");
    const events = [ev("plan.produced"), ev("setup.done"), applied] as EngineEvent[];
    expect(reopenData(events, after).skipped_tasks).toEqual([]);

    // A refused amendment and a run.message change nothing.
    const refused = ev("run.amended", {
      chat_id: "c2",
      outcome: "rejected",
      applied_at: "live",
      added: [],
      changed: [],
      dropped: [],
      kept_started: [],
      warning_count: 0,
      reason: "[L005] dependency cycle",
    });
    expect(reduce(start(), refused)).toEqual(start());
    const message = ev("run.message", { message_id: 1, kind: "chat", chat_id: "c1" });
    expect(reduce(start(), message)).toEqual(start());
  });
});

describe("W5a: the inbox drain records, refuses and waits", () => {
  function runDirWith(message: Record<string, unknown>): string {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-amend-unit-"));
    fs.mkdirSync(path.join(runDir, "inbox"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "inbox", "1.json"), JSON.stringify(message), "utf8");
    return runDir;
  }
  const amendmentMessage = { v: 1, n: 1, ts: "2026-10-22T00:00:00.000Z", kind: "amendment", chat_id: "c1", dir: "amendments/c1" };
  const stateWith = (state: string): EngineState => ({ ...start0(), state: state as EngineState["state"] });
  function start0(): EngineState {
    return { run_id: RUN as EngineState["run_id"], state: "EXECUTING", tasks: {}, usage: { total_usd: 0, by_role: {} }, checkpoints: [] };
  }

  it("refuses an amendment for a finished run: a rejected run.amended, a chat line, and the file kept in inbox/consumed", async () => {
    const runDir = runDirWith(amendmentMessage);
    const events: { type: string; data: any }[] = [];
    const emit = ((type: string, data: unknown) => {
      events.push({ type, data });
      return undefined;
    }) as any;
    const applied = await drainInbox({
      runId: RUN as any,
      repoRoot: runDir,
      runDir,
      settings: {} as Settings,
      appliedAt: "live",
      getState: () => stateWith("FINISHED"),
      mayChange: () => true,
      emit,
    });
    expect(applied).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["run.message", "run.amended"]);
    expect(events[1].data).toMatchObject({ chat_id: "c1", outcome: "rejected", reason: "job finished" });
    const chat = fs.readFileSync(path.join(runDir, "chat.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ role: "system", status: "refused", reply_to: "c1" });
    expect(fs.existsSync(path.join(runDir, "inbox", "1.json"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "inbox", "consumed", "1.json"))).toBe(true);
  });

  it("leaves an amendment in the inbox while the run is paused, to be applied on resume", async () => {
    const runDir = runDirWith(amendmentMessage);
    const events: unknown[] = [];
    const applied = await drainInbox({
      runId: RUN as any,
      repoRoot: runDir,
      runDir,
      settings: {} as Settings,
      appliedAt: "live",
      getState: () => stateWith("PAUSED"),
      mayChange: () => true,
      emit: ((type: string, data: unknown) => events.push({ type, data })) as any,
    });
    expect(applied).toBe(false);
    expect(events).toEqual([]);
    expect(fs.existsSync(path.join(runDir, "inbox", "1.json"))).toBe(true);
  });
});
