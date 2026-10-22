import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import type { EngineEvent } from "../../../src/contracts/index.js";
import { buildRunReport, plainReasonOf, renderReportMarkdown, renderReportText, type AttemptFacts } from "../../../src/engine/run-report.js";

// P2.2: the run report is built from a run's event log and the file facts the caller reads. These fixtures are
// small event logs under test/fixtures/runs; each test pins one way a run can end.

const RUN = "r_FAILEDRUN234";
const BRANCH = `substrate/runs/${RUN}`;

function eventsOf(name: string): EngineEvent[] {
  const file = path.resolve("test/fixtures/runs", `${name}.events.jsonl`);
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EngineEvent);
}

// The worker attempt that failed T2's last generation, as packets/T2-g3-attempt1.json records it.
const T2_ATTEMPT: AttemptFacts = {
  task_id: "T2",
  generation: 3,
  attempt: 1,
  files_changed: ["src/pause.ts"],
  verify: [{ cmd: "npm test", exit_code: 1, timed_out: false, stdout_tail: "FAIL test/pause.test.ts\nexpected true, got false", stderr_tail: "" }],
};

describe("P2.2 run report", () => {
  it("a failed run with one passed and one failed task names the task, its command, its patch, the branch and the resume", () => {
    const report = buildRunReport({
      runId: RUN,
      events: eventsOf("failed-partial"),
      facts: { branch: BRANCH, base_branch: "main", commits: ["Add the score counter"], patches: ["T2-g3.patch"], attempts: [T2_ATTEMPT] },
    });
    expect(report.outcome).toBe("failed");
    expect(report.merged).toBe(false);
    expect(report.verdict).toBe(
      "Nothing was merged. 1 of 2 tasks finished; T2 failed after one fix and two replans (the replan budget ran out).",
    );
    const t2 = report.tasks.find((t) => t.id === "T2");
    expect(t2?.state).toBe("failed");
    expect(t2?.failing_command).toBe("npm test");
    expect(t2?.patch_path).toBe(`.substrate/runs/${RUN}/packets/T2-g3.patch`);
    expect(t2?.output_tail).toEqual(["FAIL test/pause.test.ts", "expected true, got false"]);
    expect(report.recovery).toMatchObject({ fixes: 1, l1_replans: 1, l2_replans: 1, repairs: 0 });
    expect(report.next).toContain(`substrate resume ${RUN}  (retries the failed tasks; passed tasks are kept)`);
    expect(report.next).toContain(`git diff main..${BRANCH}`);
    expect(report.next).toContain(`git apply .substrate/runs/${RUN}/packets/T2-g3.patch`);

    const text = renderReportText(report);
    expect(text.split("\n").length - 1).toBeGreaterThanOrEqual(12);
    expect(text.split("\n").length - 1).toBeLessThanOrEqual(30);
    expect(text).toContain("Reason:     verify_failed: npm test exited 1\n");
    expect(text).toContain(`Drafts and logs: .substrate/runs/${RUN}/\n`);
    expect(text).not.toContain("NOT merged");
  });

  it("a failed final check after every task passed: the verdict says the check failed, the output tail is kept, and no partial landing is offered", () => {
    const report = buildRunReport({
      runId: RUN,
      events: eventsOf("integration-failed"),
      facts: { branch: BRANCH, base_branch: "main", commits: ["Add the score counter"], patches: [], attempts: [] },
    });
    expect(report.outcome).toBe("failed");
    expect(report.verdict).toBe(
      "Nothing was merged. All two tasks passed their own checks, but the final check failed after one repair attempt.",
    );
    expect(report.integration).toMatchObject({ result: "failed", command: "npm test" });
    expect(report.integration.output_tail.at(-1)).toBe("FAIL src/score.test.ts");
    expect(report.recovery.repair).toEqual({ attempts: 1, passed: false, reason: "the check still fails", outcomes: ["attempt 1: rejected: the check still fails"] });
    // Every task merged and the check failed: `merge --partial` would rerun the same check, so it is not offered.
    expect(report.next.some((line) => line.includes("--partial"))).toBe(false);
    expect(report.next[0]).toBe(`substrate resume ${RUN}  (runs integration verify again; fix the run branch first, then resume: git switch substrate/runs/${RUN}, commit, resume)`);
    expect(renderReportText(report)).toContain("Output:\n  line 1\n  line 2\n  FAIL src/score.test.ts\n");
  });

  it("an unclean stop (no run.finished): the outcome is stopped_uncleanly and the next command is the resume", () => {
    const report = buildRunReport({
      runId: RUN,
      events: eventsOf("unclean-stop"),
      facts: { branch: BRANCH, base_branch: "main", commits: ["Add the score counter"] },
    });
    expect(report.outcome).toBe("stopped_uncleanly");
    expect(report.verdict).toBe("The run stopped without finishing, and no end was recorded: 1 of 2 tasks finished.");
    expect(report.tasks.find((t) => t.id === "T2")?.state).toBe("interrupted");
    expect(report.next[0]).toBe(`substrate resume ${RUN}`);
    expect(renderReportText(report)).toContain(`Next:       substrate resume ${RUN}\n`);
  });

  it("a failed run names a failed setup and a passed task whose check could not run, in text and markdown (R13.1)", () => {
    const base = { v: 1, run_id: RUN, ts: "2026-10-22T10:00:00.000Z" };
    const events = [
      { ...base, seq: 1, type: "run.created", data: { run_id: RUN, base_branch: "main", merge: true } },
      { ...base, seq: 2, type: "plan.produced", data: { tasks: [{ id: "T1", title: "add the score", class: "feature", depends_on: [] }], manifest: {} } },
      { ...base, seq: 3, type: "task.setup.failed", data: { task_id: "T1", generation: 1, attempt: 1, command: "npm ci", reason: "exit 1" } },
      { ...base, seq: 4, type: "task.verify.finished", data: { task_id: "T1", generation: 1, attempt: 1, passed: true, verification_not_run: "the command was not found (exit 127)" } },
      { ...base, seq: 5, type: "task.passed", data: { task_id: "T1", generation: 1, attempt: 1 } },
      { ...base, seq: 6, type: "task.merged", data: { task_id: "T1" } },
      { ...base, seq: 7, type: "run.finished", data: { exit_code: 1, status: "failed" } },
    ] as unknown as EngineEvent[];
    const report = buildRunReport({ runId: RUN, events, facts: { branch: BRANCH, base_branch: "main" } });
    const text = renderReportText(report);
    expect(text).toContain("environment setup failed in T1: npm ci (the worker ran anyway)\n");
    expect(text).toContain("T1 passed but its check could not run: the command was not found (exit 127)\n");
    expect(report.tasks.find((t) => t.id === "T1")?.state).toBe("passed");
    expect(report.tasks.find((t) => t.id === "T1")?.verification_not_run).toBe("the command was not found (exit 127)");
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain("- environment setup failed in T1: npm ci (the worker ran anyway)");
    expect(markdown).toContain("- T1 passed but its check could not run: the command was not found (exit 127)");
  });

  it("a failure class the table does not name keeps its raw class and message", () => {
    expect(plainReasonOf("a_new_class", "something broke")).toBe("a_new_class: something broke");
    expect(plainReasonOf("a_new_class")).toBe("a_new_class");
  });
});
