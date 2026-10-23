import { describe, it, expect } from "vitest";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// 2026-10-23 (owner, d): an exception inside one task's worker action is that task's failure, not a run-level crash.
// The trigger is a broken prompt template: a project copy of worker/heal.md with a placeholder the renderer does not
// know. Heal renders that template only after a verify failure, so only T1 (which fails verify) reaches the broken
// render. T1 becomes task.failed worker_crashed and is BLOCKED, its dependent T3 is skipped, and the independent T2
// still merges. The run ends partial (exit 1). partial-success.test.ts is the model.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };
const BROKEN_HEAL_TEMPLATE = "Heal the failed checks.\n\n{{no_such_variable}}\n";

function eventsOf(res: RunSubstrateResult): Array<{ type: string; data: any }> {
  return res.events.map((e) => ({ type: e.type, data: (e.data ?? {}) as Record<string, any> }));
}

describe("2026-10-23 (d): a worker-side exception fails that task only", () => {
  it("T1 fails worker_crashed and is BLOCKED (reported as FAILED), T3 is skipped, T2 merges, and the run is partial", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const t3 = taskSpec({ id: "T3", dependsOn: ["T1"], write: ["src/c.txt"], verify: "grep -q t3-done src/c.txt" });
    const res = runSubstrate({
      files: { ...SEED, ".substrate/prompts/worker/heal.md": BROKEN_HEAL_TEMPLATE },
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Worker exception", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
          // T1 writes the wrong content, so its verify fails and heal renders the broken template.
          { task: "T1", edits: { "src/a.txt": "seed a\nwrong\n" }, reply: "DONE" },
          { task: "T2", edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" },
        ],
      },
      args: [...RUN_ARGS, "--output-format", "json", "Worker exception"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.status).toBe("partial");
      // The reducer keeps T1 BLOCKED (not replannable); the summary reports that as FAILED with its failure class.
      expect(summary.tasks.T1.state).toBe("FAILED");
      expect(summary.tasks.T1.failure_class).toBe("worker_crashed");
      expect(summary.tasks.T2.state).toBe("PASSED");
      expect(summary.tasks.T3.state).toBe("SKIPPED");

      const events = eventsOf(res);
      const failed = events.find((e) => e.type === "task.failed" && e.data.task_id === "T1");
      expect(failed?.data.failure_class).toBe("worker_crashed");
      expect(failed?.data.can_replan).toBe(false);
      expect(String(failed?.data.detail)).toContain("inside Substrate");
      expect(events.some((e) => e.type === "task.merged" && e.data.task_id === "T2")).toBe(true);
      expect(events.some((e) => e.type === "task.merged" && e.data.task_id === "T1")).toBe(false);
      const skipped = events.find((e) => e.type === "task.skipped" && e.data.task_id === "T3");
      expect(skipped?.data.failed).toEqual(["T1"]);
      // A BLOCKED task is never replanned: no replan starts and T1 is not replanned.
      expect(events.some((e) => e.type === "replan.started")).toBe(false);
      expect(events.some((e) => e.type === "task.replanned" && e.data.task_id === "T1")).toBe(false);
      expect(events.filter((e) => e.type === "run.finished")).toHaveLength(1);
    } finally {
      res.cleanup();
    }
  });
});
