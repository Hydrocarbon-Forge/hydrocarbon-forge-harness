import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { Writable } from "node:stream";

import type { EngineEvent, RunSummary } from "../../../src/contracts/index.js";
import { createFormatter, summaryPayload } from "../../../src/cli/output.js";
import { DEFAULT_HEARTBEAT_MS } from "../../../src/cli/progress.js";

// R12.3: a plan's lint warnings are noted once, after `plan ready`, and the json summary counts them.

const RUN = "r_WARNRUN00001";

function sink(): NodeJS.WriteStream & { lines: () => string[] } {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  }) as any;
  stream.isTTY = false;
  stream.lines = () => text.split("\n").filter((l) => l.trim() !== "");
  return stream;
}

let seq = 0;
function ev(type: string, data: Record<string, unknown> = {}): EngineEvent {
  seq += 1;
  return { v: 1, seq, ts: new Date().toISOString(), run_id: RUN, type, data } as EngineEvent;
}

const PLAN_TASKS = [{ id: "T1", spec: "tasks/T1.md" }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("R12.3: the plan's warnings in progress and json", () => {
  it("prints one note line right after the plan ready line, with the total, the file and the first warning", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: {}, heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("run.created", { mode: "plan" }));
    f.onEvent(
      ev("plan.produced", {
        tasks: PLAN_TASKS,
        warnings: [
          { id: "L011", task: "T1", message: "Verify binary 'nope' cannot be resolved on PATH: nope --x" },
          { id: "L021", message: "manifest.integration_verify is empty or missing" },
        ],
        warning_count: 2,
      }),
    );
    f.onEvent(ev("plan.ready", {}));
    void f.flush();

    const lines = out.lines().map((l) => l.replace(/^\[00:00\] /, ""));
    const at = lines.indexOf("plan ready: 1 task");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(
      `note: the plan has 2 warnings (see .substrate/runs/${RUN}/plan-warnings.txt); ` +
        "the first: L011 Verify binary 'nope' cannot be resolved on PATH: nope --x",
    );
    expect(lines.filter((l) => l.startsWith("note: the plan has")).length).toBe(1);
  });

  it("prints no note for a plan without warnings", () => {
    const out = sink();
    const f = createFormatter("text", out, sink(), { models: {}, heartbeatMs: DEFAULT_HEARTBEAT_MS });
    f.onEvent(ev("plan.produced", { tasks: PLAN_TASKS, warnings: [], warning_count: 0 }));
    f.onEvent(ev("plan.ready", {}));
    void f.flush();
    expect(out.lines().some((l) => l.includes("note: the plan has"))).toBe(false);
  });

  it("the json summary carries plan_warnings with the total of the last accepted plan, and nothing when there are none", () => {
    const summary = { run_id: RUN, status: "planned", tasks: {}, usage: { total_usd: 0, by_role: {} }, exit_code: 0 } as unknown as RunSummary;
    const withWarnings = summaryPayload(summary, "sess", [
      ev("plan.produced", { tasks: PLAN_TASKS, warnings: [{ id: "L007", message: "m" }], warning_count: 3 }),
    ]);
    expect(withWarnings.plan_warnings).toBe(3);

    const none = summaryPayload(summary, "sess", [ev("plan.produced", { tasks: PLAN_TASKS, warnings: [], warning_count: 0 })]);
    expect("plan_warnings" in none).toBe(false);

    const noPlan = summaryPayload(summary, "sess", []);
    expect("plan_warnings" in noPlan).toBe(false);
  });
});
