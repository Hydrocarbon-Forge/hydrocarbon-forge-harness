import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";

import type { EngineEvent, RunSummary } from "../../../src/contracts/index.js";
import { createFormatter } from "../../../src/cli/output.js";
import {
  DEFAULT_HEARTBEAT_MS,
  formatElapsed,
  heartbeatMsFromEnv,
} from "../../../src/cli/progress.js";

const RUN = "r_TESTRUN00001";

function sink(): NodeJS.WriteStream & { text: () => string; lines: () => string[] } {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  }) as any;
  stream.isTTY = false;
  stream.text = () => text;
  stream.lines = () => text.split("\n").filter((l) => l.trim() !== "");
  return stream;
}

let seq = 0;
function ev(type: string, data: Record<string, unknown> = {}): EngineEvent {
  seq += 1;
  return { v: 1, seq, ts: new Date().toISOString(), run_id: RUN, type, data } as EngineEvent;
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: RUN,
    status: "finished",
    tasks: {
      T1: { state: "MERGED", generation: 1 },
      T2: { state: "MERGED", generation: 1 },
    },
    usage: { total_usd: 0.1234, by_role: {} },
    branch: `substrate/runs/${RUN}`,
    exit_code: 0,
    ...overrides,
  } as RunSummary;
}

const MODELS = { planner: "claude:opus", worker: "claude:haiku" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("progress line shapes (text mode, stdout)", () => {
  it("prints the start, routing, planning, plan, task, verify, merge and finish lines in order", () => {
    const out = sink();
    const err = sink();
    const f = createFormatter("text", out, err, { models: MODELS, heartbeatMs: DEFAULT_HEARTBEAT_MS });

    f.onEvent(ev("run.created", { mode: "auto" }));
    f.onEvent(ev("run.routed", { mode: "plan", rationale: "no mechanical verb" }));
    f.onEvent(ev("plan.started", {}));
    f.onEvent(ev("usage.recorded", { record: { cost_usd: 0.02 }, role: "planner" }));
    f.onEvent(
      ev("plan.produced", {
        tasks: [
          { id: "T1", spec: "tasks/T1.md", title: "Add helper", class: "feature", depends_on: [] },
          { id: "T2", spec: "tasks/T2.md", title: "Wire helper", class: "tests", depends_on: ["T1"] },
        ],
      })
    );
    f.onEvent(ev("plan.approved", {}));
    f.onEvent(ev("task.session.started", { task_id: "T1", generation: 1, attempt: 1, session_id: "s", backend: "claude", model: "haiku" }));
    f.onEvent(ev("usage.recorded", { record: { cost_usd: 0.01 }, role: "worker", task_id: "T1" }));
    f.onEvent(ev("task.session.ended", { task_id: "T1" }));
    f.onEvent(ev("task.verify.started", { task_id: "T1", generation: 1, attempt: 1 }));
    f.onEvent(ev("task.verify.finished", { task_id: "T1", generation: 1, attempt: 1, passed: true }));
    f.onEvent(ev("task.passed", { task_id: "T1" }));
    f.onEvent(ev("task.merged", { task_id: "T1" }));
    f.onSummary(summary(), "sess_1");
    void f.flush();

    // R10.2: two announcement lines follow the start line. They are checked here, and the shape
    // below is checked without them, so its line numbers are unchanged.
    const all = out.lines();
    expect(all.slice(1, 3)).toEqual([
      `[00:00] follow this run from another terminal: substrate watch ${RUN}`,
      `[00:00] log: .substrate/runs/${RUN}/progress.log`,
    ]);
    const lines = [all[0], ...all.slice(3)];
    expect(lines[0]).toBe(`[00:00] run ${RUN} started: mode auto, planner claude:opus, worker claude:haiku`);
    expect(lines[1]).toBe("[00:00] routed to plan (no mechanical verb)");
    expect(lines[2]).toBe("[00:00] planning with claude:opus");
    expect(lines[3]).toBe("[00:00] planner attempt 1 finished, $0.0200");
    expect(lines[4]).toBe("[00:00] plan ready: 2 tasks");
    expect(lines[5]).toBe("[00:00]   T1  Add helper  [feature]");
    expect(lines[6]).toBe("[00:00]   T2  Wire helper  [tests]  after T1");
    expect(lines[7]).toBe("[00:00] [task T1] started (gen 1, attempt 1) on claude:haiku");
    expect(lines[8]).toBe("[00:00] [task T1] worker finished, $0.0100");
    expect(lines[9]).toBe("[00:00] [task T1] verify passed");
    expect(lines[10]).toBe("[00:00] [task T1] merged, $0.0100");
    expect(lines[11]).toBe(`[00:00] run ${RUN} finished: 2/2 passed, $0.1234`);
    // The lines helper drops blank lines, so the summary block starts right after the finish line.
    expect(lines[12]).toBe("--- Run Summary ---");
    expect(err.text()).toBe("");
  });

  it("prints every planner format rejection with its attempt, cost and the first two messages", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: MODELS, heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(ev("plan.started", {}));
    f.onEvent(ev("usage.recorded", { record: { cost_usd: 0.05 }, role: "planner" }));
    f.onEvent(
      ev("plan.format_rejected", {
        attempt: 1,
        max_attempts: 3,
        errors: ["[L003] path does not exist", "[L019] second problem", "[L027] third"],
      })
    );
    f.onEvent(ev("usage.recorded", { record: { cost_usd: 0.03 }, role: "planner" }));
    f.onEvent(ev("plan.produced", { tasks: [] }));
    const lines = out.lines();
    expect(lines).toContain("[00:00] planner attempt 1/3 finished, $0.0500");
    expect(lines).toContain("[00:00] plan rejected (attempt 1/3): [L003] path does not exist; [L019] second problem");
    expect(lines).toContain("[00:00] planner attempt 2 finished, $0.0300");
  });

  it("names the failing verify command and keeps its output to one line", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("task.verify.finished", {
      task_id: "T3",
      generation: 1,
      attempt: 1,
      passed: false,
      failure_class: "verify_failed",
      failed_command: "npm test",
      failed_output: "AssertionError: expected 2 to be 3",
    }));
    f.onEvent(ev("task.failed", { task_id: "T3", failure_class: "verify_failed", message: "npm test failed" }));
    expect(out.lines()).toEqual([
      "[00:00] [task T3] verify failed: npm test (AssertionError: expected 2 to be 3)",
      "[00:00] [task T3] failed: verify_failed: npm test failed",
    ]);
  });

  it("R11.3: a planning reopen says the planning was cut short when no plan existed, and keeps the old line when a plan was refused", () => {
    const cut = sink();
    createFormatter("text", cut, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS }).onEvent(
      ev("run.reopened", { reason: "planning", planning_cut_short: true, max_budget_usd: 5, time_limit_s: null }),
    );
    expect(cut.lines()).toEqual([
      "[00:00] planning was cut short before a plan was produced; planning again (planning costs again)",
    ]);
    const refused = sink();
    createFormatter("text", refused, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS }).onEvent(
      ev("run.reopened", { reason: "planning", time_limit_s: null }),
    );
    expect(refused.lines()).toEqual(["[00:00] no plan was accepted; planning again (planning costs again)"]);
  });

  it("R7.11, R11.3: the base-check note is printed only after a final verify that fails, and nothing extra when it passes", () => {
    const failed = sink();
    const f1 = createFormatter("text", failed, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f1.onEvent(ev("integration.started", { base_verify_passed: false }));
    expect(failed.lines()).toEqual(["[00:00] integration verify started"]);
    f1.onEvent(ev("integration.failed", { failure_class: "integration_failed", message: "x", command: "npm test", exit_code: 1 }));
    expect(failed.lines()).toEqual([
      "[00:00] integration verify started",
      "[00:00] integration verify failed: npm test (exit 1)",
      "[00:00] note: integration verify also failed on the base commit, before this run's changes, so the check was failing before this run started",
    ]);
    const passed = sink();
    const f2 = createFormatter("text", passed, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f2.onEvent(ev("integration.started", {}));
    expect(passed.lines()).toEqual(["[00:00] integration verify started"]);
  });

  it("names the failing integration command and its exit code (R7.11); older logs print the plain line", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("integration.failed", { failure_class: "integration_failed", command: "test -f src/never.txt", exit_code: 1 }));
    f.onEvent(ev("integration.failed", { base: true }));
    expect(out.lines()).toEqual([
      "[00:00] integration verify failed: test -f src/never.txt (exit 1)",
      "[00:00] integration verify failed",
    ]);
  });

  it("prints a run pause on stdout, not stderr", () => {
    const out = sink();
    const err = sink();
    const f = createFormatter("text", out, err, { heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("run.paused", { reason: "needs_human" }));
    expect(out.lines()).toEqual(["[00:00] run paused: needs_human"]);
    expect(err.text()).toBe("");
  });
});

describe("heartbeat", () => {
  it("writes a still-working line after 15 seconds of silence, and again every 15 seconds", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: MODELS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(ev("plan.started", {}));
    const before = out.lines().length;

    vi.advanceTimersByTime(14_000);
    expect(out.lines().length).toBe(before);

    vi.advanceTimersByTime(1_000);
    expect(out.lines().slice(before)).toEqual([
      "[00:15] still working: planning (15s; cost is reported when planning ends)",
    ]);

    vi.advanceTimersByTime(15_000);
    expect(out.lines().slice(before)).toEqual([
      "[00:15] still working: planning (15s; cost is reported when planning ends)",
      "[00:30] still working: planning (30s; cost is reported when planning ends)",
    ]);
    void f.flush();
  });

  it("writes no heartbeat while events keep producing lines", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: MODELS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      f.onEvent(ev("plan.started", {}));
    }
    expect(out.lines().some((l) => l.includes("still working"))).toBe(false);
    void f.flush();
  });

  it("tracks the phase: planning, task running, verifying, merging, scheduling", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(ev("plan.started", {}));
    f.onEvent(ev("plan.approved", {}));
    f.onEvent(ev("task.session.started", { task_id: "T2", generation: 1, attempt: 1, session_id: "s" }));
    vi.advanceTimersByTime(15_000);
    f.onEvent(ev("task.verify.started", { task_id: "T2", generation: 1, attempt: 1 }));
    vi.advanceTimersByTime(15_000);
    f.onEvent(ev("task.passed", { task_id: "T2" }));
    vi.advanceTimersByTime(15_000);
    f.onEvent(ev("task.merged", { task_id: "T2" }));
    vi.advanceTimersByTime(15_000);
    const beats = out.lines().filter((l) => l.includes("still working"));
    // The phase changes at each event; a beat reports the phase it is in.
    // No usage record in this run, so every phase reports no cost yet, and says when it will.
    expect(beats).toEqual([
      "[00:15] still working: task T2 running (15s; cost is reported when this step ends)",
      "[00:30] still working: verifying T2 (15s; cost is reported when this step ends)",
      "[00:45] still working: merging T2 (15s; cost is reported when this step ends)",
      "[01:00] still working: scheduling (15s; cost is reported when this step ends)",
    ]);
    void f.flush();
  });

  it("names every worker that is running at once (R8.3): running T1, T2 while two sessions run, then the one left", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: MODELS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(ev("plan.started", {}));
    f.onEvent(ev("plan.approved", {}));
    f.onEvent(ev("task.session.started", { task_id: "T2", generation: 1, attempt: 1, session_id: "s2" }));
    f.onEvent(ev("task.session.started", { task_id: "T1", generation: 1, attempt: 1, session_id: "s1" }));
    vi.advanceTimersByTime(15_000);
    f.onEvent(ev("task.session.ended", { task_id: "T1", generation: 1, attempt: 1 }));
    f.onEvent(ev("task.verify.started", { task_id: "T1", generation: 1, attempt: 1 }));
    vi.advanceTimersByTime(15_000);
    const beats = out.lines().filter((l) => l.includes("still working"));
    expect(beats).toEqual([
      "[00:15] still working: running T1, T2 (15s; cost is reported when this step ends)",
      "[00:30] still working: task T2 running (15s; cost is reported when this step ends)",
    ]);
    void f.flush();
  });

  it("shows no dollar amount before the first usage record, and the running total after it", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: MODELS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(ev("plan.started", {}));
    vi.advanceTimersByTime(15_000);
    f.onEvent(ev("usage.recorded", { record: { cost_usd: 0.25 }, role: "planner" }));
    vi.advanceTimersByTime(15_000);
    const beats = out.lines().filter((l) => l.includes("still working"));
    expect(beats).toEqual([
      "[00:15] still working: planning (15s; cost is reported when planning ends)",
      "[00:30] still working: planning (30s, $0.2500)",
    ]);
    expect(beats[0]).not.toContain("$");
    void f.flush();
  });

  it("names this step rather than planning when a non-planning phase has no cost yet", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("run.created", { mode: "solo" }));
    f.onEvent(ev("plan.approved", {}));
    f.onEvent(ev("task.session.started", { task_id: "T1", generation: 1, attempt: 1, session_id: "s" }));
    vi.advanceTimersByTime(15_000);
    expect(out.lines().filter((l) => l.includes("still working"))).toEqual([
      "[00:15] still working: task T1 running (15s; cost is reported when this step ends)",
    ]);
    void f.flush();
  });

  it("is cleared at the summary, so no heartbeat follows the run", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: MODELS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onSummary(summary({ status: "failed", exit_code: 1 }), "sess");
    const count = out.lines().length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(out.lines().length).toBe(count);
  });

  it("honours an injected interval", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { heartbeatMs: 2_000 });
    f.onEvent(ev("run.created", { mode: "solo" }));
    vi.advanceTimersByTime(2_000);
    expect(out.lines().some((l) => l.includes("still working: starting (2s"))).toBe(true);
    void f.flush();
  });

  it("writes a heartbeat object in stream-json with the phase, elapsed seconds and cost", () => {
    const out = sink();
    const f = createFormatter("stream-json", out, sink(), { models: MODELS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(ev("plan.started", {}));
    f.onEvent(ev("usage.recorded", { record: { cost_usd: 0.25 }, role: "planner" }));
    vi.advanceTimersByTime(15_000);
    const beat = out.lines().map((l) => JSON.parse(l)).find((p) => p.type === "heartbeat");
    expect(beat).toBeDefined();
    expect(beat.run_id).toBe(RUN);
    expect(beat.phase).toBe("planning");
    expect(beat.elapsed_s).toBe(15);
    expect(beat.phase_elapsed_s).toBe(15);
    expect(beat.cost_usd).toBeCloseTo(0.25, 6);
    expect(typeof beat.ts).toBe("string");
    void f.flush();
  });

  it("writes cost_usd as null in stream-json until the first usage record, then the running total", () => {
    const out = sink();
    const f = createFormatter("stream-json", out, sink(), { models: MODELS });
    const beats = () => out.lines().map((l) => JSON.parse(l)).filter((p) => p.type === "heartbeat");
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(ev("plan.started", {}));
    vi.advanceTimersByTime(15_000);
    expect(beats()).toHaveLength(1);
    expect(beats()[0].cost_usd).toBeNull();
    expect(beats()[0]).toHaveProperty("cost_usd", null);

    f.onEvent(ev("usage.recorded", { record: { cost_usd: 0.25 }, role: "planner" }));
    vi.advanceTimersByTime(15_000);
    expect(beats()).toHaveLength(2);
    expect(beats()[1].cost_usd).toBeCloseTo(0.25, 6);
    void f.flush();
  });
});

describe("heartbeat configuration", () => {
  it("reads SUBSTRATE_HEARTBEAT_MS and falls back to 15 seconds", () => {
    expect(heartbeatMsFromEnv({})).toBe(15_000);
    expect(heartbeatMsFromEnv({ SUBSTRATE_HEARTBEAT_MS: "" })).toBe(15_000);
    expect(heartbeatMsFromEnv({ SUBSTRATE_HEARTBEAT_MS: "abc" })).toBe(15_000);
    expect(heartbeatMsFromEnv({ SUBSTRATE_HEARTBEAT_MS: "-5" })).toBe(15_000);
    expect(heartbeatMsFromEnv({ SUBSTRATE_HEARTBEAT_MS: "250" })).toBe(250);
  });

  it("formats elapsed time as mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_900)).toBe("01:05");
    expect(formatElapsed(3_600_000)).toBe("60:00");
  });
});
