import { describe, it, expect } from "vitest";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";

// R7.9: a planner failure says why. The budget cap is a budget_exceeded failure; any other
// session failure names what the harness reported; a run that never created its branch says so.

const CONTRACT_STUB = "export {};\n";
const PLAN_ARGS = ["run", "--mode", "plan", "--permission-mode", "plan"];

/** claude's planner session ends with an error result after 0.55 USD of spend (no spend cap is passed since 2026-10-23). */
const BUDGET_STOPPED_PLANNER = { failure: "budget", cost_usd: 0.55, reply: "" };

/** claude ends the planner's turn with an error result and no reply text. */
const ERRORED_PLANNER = { failure: "error_result", reply: "" };

function failedEvents(res: RunSubstrateResult): Array<{ failure_class?: string; message?: string }> {
  return res.events
    .filter((e) => e.type === "task.failed")
    .map((e) => (e.data ?? {}) as { failure_class?: string; message?: string });
}

describe("R7.9: planner failures name their cause", () => {
  it(
    "a planning failure prints no branch and says resume re-runs planning",
    () => {
      const res = runSubstrate({
        files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
        scenario: { calls: [BUDGET_STOPPED_PLANNER] },
        args: [...PLAN_ARGS, "Run the planning failure hint case"],
      });
      try {
        expect(res.exitCode).toBe(1);
        // The run never created its branch, so the summary names none.
        expect(res.stdout).toContain("Branch:     (none, planning failed)");
        expect(res.stdout).not.toMatch(/Branch:\s+substrate\/runs\//);
        // R10.4: a failed planning run is resumed, and resume plans again (the cost is named).
        expect(res.stdout).toMatch(/Next:       substrate resume r_\w+  \(plans again; planning costs again\)/);
      } finally {
        res.cleanup();
      }
    },
    60000,
  );

  it(
    "the json summary of a planning failure carries no branch name",
    () => {
      const res = runSubstrate({
        files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
        scenario: { calls: [BUDGET_STOPPED_PLANNER] },
        args: [...PLAN_ARGS, "--output-format", "json", "Run the planning failure json case"],
      });
      try {
        expect(res.exitCode).toBe(1);
        const summary = JSON.parse(res.stdout) as { branch?: string; failure_class?: string };
        expect(summary).not.toHaveProperty("branch");
        // The planner's error result is an ordinary failed session now: no spend cap ends it (owner, 2026-10-23).
        expect(summary.failure_class).toBe("worker_crashed");
      } finally {
        res.cleanup();
      }
    },
    60000,
  );

  it(
    "a planner error result names the subtype and the error lines the harness reported",
    () => {
      const res = runSubstrate({
        files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
        scenario: { calls: [ERRORED_PLANNER] },
        args: [...PLAN_ARGS, "Run the errored planner case"],
      });
      try {
        expect(res.exitCode).toBe(1);
        const failed = failedEvents(res);
        expect(failed).toHaveLength(1);
        expect(failed[0].failure_class).toBe("worker_crashed");
        expect(failed[0].message).toBe(
          "Planner session failed with exit code 1: harness error: error_during_execution: fake harness aborted the turn",
        );
        expect(res.stdout).toContain("[plan] failed: worker_crashed: Planner session failed with exit code 1");
        expect(res.stdout).toContain("fake harness aborted the turn");
      } finally {
        res.cleanup();
      }
    },
    60000,
  );
});
