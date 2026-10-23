import { describe, it, expect } from "vitest";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// The no-output idle watchdog (owner, 2026-10-23) is a hang detector, not a work limit. These tests use the claude
// fake only, with scripted timing: a session that keeps writing is never killed, and 0 turns the watchdog off. The hang
// case for all three harnesses is scenario 8 in matrix.test.ts.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "contracts/types.ts": CONTRACT_STUB };

function eventsOf(res: RunSubstrateResult): Array<{ type: string; data: any }> {
  return res.events.map((e) => ({ type: e.type, data: (e.data ?? {}) as Record<string, any> }));
}

function singleTaskRun(worker: Record<string, unknown>, settings: Record<string, unknown>, args: string): RunSubstrateResult {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q marker src/a.txt" });
  return runSubstrate({
    files: SEED,
    scenario: {
      calls: [
        planCall(contractFiles(manifestFor("Idle watchdog", ["T1"]), { "tasks/T1.md": t1 })),
        { ...worker, edits: { "src/a.txt": "seed a\nmarker\n" }, reply: "DONE" },
      ],
    },
    settings,
    args: [...RUN_ARGS, args],
  });
}

describe("no-output idle watchdog: busy sessions are not killed, and 0 turns it off", () => {
  it("a session that keeps writing, with gaps under the limit, runs past the limit in total and is not killed", () => {
    // The idle limit is 0.03 min (1.8 s). The worker writes a line every 400 ms for 12 lines, about 4.8 s in all:
    // a total-time watchdog would kill it, the no-output watchdog must not.
    const res = singleTaskRun(
      { trickle: { count: 12, interval_ms: 400 } },
      { watchdog: { idle_minutes: 0.03 } },
      "Run the busy session case",
    );
    try {
      expect(res.exitCode).toBe(0);
      const events = eventsOf(res);
      expect(events.some((e) => e.type === "task.failed")).toBe(false);
      expect(events.some((e) => e.type === "task.merged" && e.data.task_id === "T1")).toBe(true);
    } finally {
      res.cleanup();
    }
  }, 60000);

  it("with watchdog.idle_minutes 0, a silent session that runs longer than the small limit is not killed", () => {
    // 2.5 s of silence before the reply. With the limit at 0.03 min (1.8 s) this session would be killed (scenario 8);
    // with 0 the watchdog is off and the session finishes.
    const res = singleTaskRun({ delay_ms: 2500 }, { watchdog: { idle_minutes: 0 } }, "Run the disabled watchdog case");
    try {
      expect(res.exitCode).toBe(0);
      const events = eventsOf(res);
      expect(events.some((e) => e.type === "task.failed")).toBe(false);
      expect(events.some((e) => e.type === "task.merged" && e.data.task_id === "T1")).toBe(true);
    } finally {
      res.cleanup();
    }
  }, 60000);
});
