import { describe, it, expect } from "vitest";

import { PLANNER_MIN_USD, plannerSpawnBudgetUsd } from "../../../src/roles/planner.js";

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
