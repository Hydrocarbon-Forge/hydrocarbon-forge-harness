import { describe, it, expect } from "vitest";

import {
  PLANNER_MIN_USD,
  plannerBudgetMessage,
  plannerSpawnBudgetUsd,
  sessionFailureMessage,
} from "../../../src/roles/planner.js";

// R7.9: the planner's session cap is the run budget not yet spent, never the per-task cap.
describe("R7.9: planner spawn budget", () => {
  it("is the whole run budget before anything is spent", () => {
    expect(plannerSpawnBudgetUsd(5, 0)).toBe(5);
  });

  it("is the remaining run budget after spend", () => {
    expect(plannerSpawnBudgetUsd(5, 1.5)).toBeCloseTo(3.5, 10);
  });

  it("is floored at the planner minimum when little run budget is left", () => {
    expect(plannerSpawnBudgetUsd(5, 4.9)).toBe(PLANNER_MIN_USD);
    expect(plannerSpawnBudgetUsd(5, 7)).toBe(PLANNER_MIN_USD);
  });

  it("is never above the run cap, even when the run cap is below the floor", () => {
    expect(plannerSpawnBudgetUsd(0.2, 0)).toBe(0.2);
  });
});

// R7.9: the session failure and budget messages name what happened.
describe("R7.9: planner failure messages", () => {
  it("a session with no error output from the harness says so", () => {
    expect(sessionFailureMessage(1, "", undefined, "claude")).toBe(
      "Planner session failed with exit code 1: no error output from claude",
    );
  });

  it("a session that reports a harness error keeps it after the exit code", () => {
    expect(sessionFailureMessage(1, "", "Process crashed with exit code 1", "claude")).toBe(
      "Planner session failed with exit code 1: harness error: Process crashed with exit code 1",
    );
  });

  it("a budget stop names the cap it hit, what was spent and the run budget", () => {
    expect(plannerBudgetMessage(5, 0.55, 5)).toBe(
      "planner stopped at its budget cap of $5.00 (spent $0.55); the run budget is $5.00",
    );
  });
});
