import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Diagnostic } from "../../../src/contracts/index.js";
import {
  MAX_EVENT_WARNINGS,
  PLAN_WARNINGS_FILE,
  planWarningsEventData,
  planWarningsOf,
  writePlanWarnings,
} from "../../../src/roles/planner.js";

// R12.3: the warnings of an accepted plan are recorded in the run directory and carried by plan.produced.

describe("R12.3: plan warnings", () => {
  it("planWarningsOf keeps the rule id and the task, and takes the run directory and repository root out of the message", () => {
    const runDir = "/work/repo/.substrate/runs/r_X";
    const repoRoot = "/work/repo";
    const diags: Diagnostic[] = [
      {
        code: "L011",
        severity: "warn",
        task: "T1",
        message: `Verify binary 'nope' cannot be resolved on PATH: nope --x\n  in ${runDir}/tasks/T1.md`,
      },
      { code: "L021", severity: "warn", message: `manifest at ${repoRoot}/manifest.yaml  is empty` },
    ];
    const out = planWarningsOf(diags, runDir, repoRoot);
    expect(out[0]).toEqual({
      id: "L011",
      task: "T1",
      message: "Verify binary 'nope' cannot be resolved on PATH: nope --x in tasks/T1.md",
    });
    expect(out[1]).toEqual({ id: "L021", message: "manifest at manifest.yaml is empty" });
    expect(JSON.stringify(out)).not.toContain("/work/repo");
  });

  it("writePlanWarnings writes id, task and message per line, and - for a plan-wide warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-plan-warnings-"));
    writePlanWarnings(dir, [
      { id: "L009", task: "T2", message: "Task T2 modifies path 'src/a.ts' protected by task T1" },
      { id: "L021", message: "manifest.integration_verify is empty or missing" },
    ]);
    const lines = readFileSync(join(dir, PLAN_WARNINGS_FILE), "utf8").trimEnd().split("\n");
    expect(lines).toEqual([
      "L009\tT2\tTask T2 modifies path 'src/a.ts' protected by task T1",
      "L021\t-\tmanifest.integration_verify is empty or missing",
    ]);
  });

  it("writePlanWarnings removes a stale file when the accepted plan has no warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-plan-warnings-"));
    writeFileSync(join(dir, PLAN_WARNINGS_FILE), "L007\t-\tstale\n", "utf8");
    writePlanWarnings(dir, []);
    expect(existsSync(join(dir, PLAN_WARNINGS_FILE))).toBe(false);
  });

  it("planWarningsEventData carries at most 20 warnings with 300-character messages, and the total", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: "L008", message: `m${i} ${"x".repeat(400)}` }));
    const data = planWarningsEventData(many);
    expect(data.warning_count).toBe(25);
    expect(data.warnings.length).toBe(MAX_EVENT_WARNINGS);
    expect(MAX_EVENT_WARNINGS).toBe(20);
    expect(data.warnings.every((w) => w.message.length <= 300)).toBe(true);
    expect(data.warnings[0].message.startsWith("m0 ")).toBe(true);
  });

  it("planWarningsEventData of a plan without warnings is an empty list and a zero count", () => {
    expect(planWarningsEventData([])).toEqual({ warnings: [], warning_count: 0 });
  });
});
