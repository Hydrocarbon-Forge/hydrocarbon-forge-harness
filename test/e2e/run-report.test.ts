import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { runSubstrate } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// P2.2: a run that does not succeed says what happened, what it left and what to run next; a run that
// succeeds prints no failure report. Both cases run the built CLI against the fake harnesses.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };

function diagnostics(res: { stdout: string; stderr: string }): string {
  return `stdout: ${res.stdout.slice(-1500)}\nstderr: ${res.stderr.slice(-800)}`;
}

describe("P2.2 run report at the end of a run", () => {
  it("a task that fails ends with a report that names the task, its saved patch, the run branch and the resume", () => {
    // T1 passes, T2 fails through its ladder, T3 depends on T2 and is skipped.
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q never-there src/b.txt" });
    const t3 = taskSpec({ id: "T3", write: ["src/c.txt"], dependsOn: ["T2"], verify: "grep -q t3-done src/c.txt" });
    const ladder = Array.from({ length: 12 }, () => ({ reply: "DONE" }));
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Report", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" },
          { edits: { "src/b.txt": "seed b\nbroken\n" }, reply: "DONE" },
          { edits: { "src/b.txt": "seed b\nbroken again\n" }, reply: "DONE" },
          ...ladder,
        ],
      },
      args: [...RUN_ARGS, "Report case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(1);
      const runId = basename(res.runDir as string);
      expect(res.stdout).toMatch(/Nothing was merged\. 1 of 3 tasks finished; T2 failed/);
      expect(res.stdout).toMatch(/T2\s+failed/);
      expect(res.stdout).toMatch(/\.substrate\/runs\/r_\w+\/packets\/T2-g\d+\.patch/);
      expect(res.stdout).toMatch(/substrate\/runs\/r_\w+/);
      expect(res.stdout).toContain(`Next:       substrate resume ${runId}  (retries the failed tasks; passed tasks are kept)`);
      expect(res.stdout).not.toContain("NOT merged");
      // The same account is kept as REPORT.md in the run directory.
      const report = readFileSync(join(res.runDir as string, "REPORT.md"), "utf8");
      expect(report).toMatch(/^# Run r_\w+: failed/);
      expect(report).toContain("T2");
    } finally {
      res.cleanup();
    }
  });

  it("a run that finishes prints no failure report", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Clean", ["T1"]), { "tasks/T1.md": t1 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" },
        ],
      },
      args: [...RUN_ARGS, "Clean case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(res.stdout).toContain("Merged:     yes");
      for (const marker of ["Nothing was merged", "Per task:", "Produced:", "Reason:", "Drafts and logs"]) {
        expect(res.stdout).not.toContain(marker);
      }
      expect(readFileSync(join(res.runDir as string, "REPORT.md"), "utf8")).toMatch(/^# Run r_\w+: finished/);
    } finally {
      res.cleanup();
    }
  });
});
