import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";

import type { RunSummary } from "../../../src/contracts/index.js";
import { JSON_FILES_LIMIT, MERGE_TURNED_OFF_REASON, TEXT_FILES_LIMIT, failureOf, withLanding } from "../../../src/engine/landing.js";
import { createFormatter } from "../../../src/cli/output.js";

// R7.4: the landing fields, and the text, json and stream-json summaries that carry them.

const RUN_ID = "r_TESTRUNABCD";

function summaryOf(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: RUN_ID,
    status: "finished",
    tasks: { T1: { state: "PASSED", generation: 1 } },
    usage: { total_usd: 0.25, by_role: {} },
    branch: `substrate/runs/${RUN_ID}`,
    exit_code: 0,
    ...overrides,
  };
}

function sink(): { stream: NodeJS.WriteStream; text: () => string } {
  const pass = new PassThrough();
  let buffer = "";
  pass.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  return { stream: pass as unknown as NodeJS.WriteStream, text: () => buffer };
}

function files(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `src/file-${String(i).padStart(2, "0")}.txt`);
}

describe("R7.4 failureOf", () => {
  it("returns the last event that names a failure_class, with its message or detail", () => {
    const found = failureOf([
      { type: "task.failed", data: { failure_class: "verify_failed", message: "first" } },
      { type: "task.started", data: { task_id: "T1" } },
      { type: "task.failed", data: { failure_class: "timeout", detail: "took too long" } },
    ]);
    expect(found).toEqual({ failure_class: "timeout", message: "took too long" });
  });

  it("is undefined when no event names a failure class", () => {
    expect(failureOf([{ type: "run.finished", data: { exit_code: 1 } }])).toBeUndefined();
  });
});

describe("R7.4 withLanding", () => {
  it("merged run: no merge command, the file list, and no failure fields", () => {
    const out = withLanding(summaryOf(), {
      merged: true,
      base_branch: "main",
      files: ["a.txt"],
      runFailed: false,
      needsInput: false,
    });
    expect(out).toMatchObject({ merged: true, base_branch: "main", files_changed: ["a.txt"], files_changed_total: 1, next: [] });
    expect(out).not.toHaveProperty("drafts_dir");
    expect(out).not.toHaveProperty("failure_class");
  });

  it("finished but not merged: next names the merge command", () => {
    const out = withLanding(summaryOf(), { merged: false, base_branch: "main", files: [], runFailed: false, needsInput: false });
    expect(out.next).toEqual([`substrate merge ${RUN_ID}`]);
  });

  it("caps files_changed at 50 names and keeps the full count", () => {
    const all = files(JSON_FILES_LIMIT + 7);
    const out = withLanding(summaryOf(), { merged: false, base_branch: "main", files: all, runFailed: false, needsInput: false });
    expect(out.files_changed).toHaveLength(JSON_FILES_LIMIT);
    expect(out.files_changed_total).toBe(JSON_FILES_LIMIT + 7);
  });

  it("failed run: drafts_dir, the failing class and message, and next names no resume (known issue 41)", () => {
    const out = withLanding(summaryOf({ status: "failed", exit_code: 1 }), {
      merged: false,
      base_branch: "main",
      files: [],
      runFailed: true,
      needsInput: false,
      failure: { failure_class: "verify_failed", message: "npm test failed" },
    });
    expect(out).toMatchObject({
      drafts_dir: `.substrate/runs/${RUN_ID}`,
      failure_class: "verify_failed",
      message: "npm test failed",
      // R10.4: a failed run is resumed; the first next line is the resume, the last a new request.
      next: [`substrate resume ${RUN_ID}  (retries the failed tasks; passed tasks are kept)`, "Start a new run with a narrower request"],
    });
  });

  it("failed run with no failing event: the pause reason or status stands in, and the message is empty", () => {
    const out = withLanding(summaryOf({ status: "paused", pause_reason: "budget_exhausted", exit_code: 4 }), {
      merged: false,
      base_branch: "main",
      files: [],
      runFailed: true,
      needsInput: false,
    });
    expect(out).toMatchObject({ failure_class: "budget_exhausted", message: "" });
  });
});

describe("R7.4 text summary", () => {
  function render(summary: RunSummary): string {
    const out = sink();
    const err = sink();
    const formatter = createFormatter("text", out.stream, err.stream);
    formatter.onSummary(summary, "sess_test");
    return out.text();
  }

  it("merged: Result, the merged line and the file names", () => {
    const text = render(
      withLanding(summaryOf(), { merged: true, base_branch: "main", files: ["a.txt", "b.txt"], runFailed: false, needsInput: false }) as RunSummary,
    );
    expect(text).toContain("Merged:     yes\n");
    expect(text).toContain(`Result:     2 files changed on branch substrate/runs/${RUN_ID}\n`);
    expect(text).toContain("Merged into main (working tree updated)\n");
    expect(text).toContain("Files:\n  a.txt\n  b.txt\n");
    expect(text).not.toContain("Drafts and logs");
  });

  it("not merged: the exact merge command in the NOT merged line", () => {
    const text = render(
      withLanding(summaryOf(), { merged: false, base_branch: "main", files: ["a.txt"], runFailed: false, needsInput: false }) as RunSummary,
    );
    expect(text).toContain("Merged:     no\n");
    expect(text).toContain(`NOT merged into main yet — run: substrate merge ${RUN_ID}\n`);
  });

  // R10.1: a finished run kept on its branch because merging was turned off says so, and names the merge command.
  it("finished, merging turned off: the Result line says so, the Next line names the merge command, and no NOT merged line", () => {
    const text = render(
      withLanding(summaryOf(), {
        merged: false, base_branch: "main", files: ["a.txt"], runFailed: false, needsInput: false,
        notMergedReason: MERGE_TURNED_OFF_REASON,
      }) as RunSummary,
    );
    expect(text).toContain("Merged:     no\n");
    expect(text).toContain(`Result:     finished: work is on branch substrate/runs/${RUN_ID}, not merged (merging was turned off)\n`);
    expect(text).toContain(`Next:       substrate merge ${RUN_ID}\n`);
    expect(text).not.toContain("NOT merged into");
  });

  // R10.1: a refused landing prints its reason, and the reason is the only line for it.
  it("a refused landing prints its reason line", () => {
    const text = render(
      withLanding(summaryOf(), {
        merged: false, base_branch: "main", files: ["a.txt"], runFailed: false, needsInput: false,
        notMergedReason: `not merged: you switched from main to other while the run was working; check out main and run: substrate merge ${RUN_ID}`,
      }) as RunSummary,
    );
    expect(text).toContain(`not merged: you switched from main to other while the run was working; check out main and run: substrate merge ${RUN_ID}\n`);
    expect(text).not.toContain("NOT merged into");
  });

  // R9.1: a finished run whose branch holds the work and which is not merged says so in the Result line.
  it("finished, not merged, work on the branch: the Result line says where the work is", () => {
    const text = render(
      withLanding(summaryOf(), { merged: false, base_branch: "main", files: ["a.txt"], runFailed: false, needsInput: false }) as RunSummary,
    );
    expect(text).toContain("Merged:     no\n");
    expect(text).toContain(`Result:     finished: work is on branch substrate/runs/${RUN_ID}, not merged yet\n`);
    expect(text).not.toContain("1 files changed on branch");
    expect(text).toContain(`NOT merged into main yet — run: substrate merge ${RUN_ID}\n`);
  });

  // R9.1: the summary's cost has the same four decimals as the progress line.
  it("Total Cost has four decimals, like the progress line", () => {
    const text = render(
      withLanding(summaryOf({ usage: { total_usd: 0.0869, by_role: {} } }), {
        merged: true, base_branch: "main", files: ["a.txt"], runFailed: false, needsInput: false,
      }) as RunSummary,
    );
    expect(text).toContain("Total Cost: $0.0869\n");
    expect(text).not.toContain("Total Cost: $0.09\n");
  });

  it("lists at most TEXT_FILES_LIMIT names and says how many more", () => {
    const all = files(TEXT_FILES_LIMIT + 3);
    const text = render(
      withLanding(summaryOf(), { merged: false, base_branch: "main", files: all, runFailed: false, needsInput: false }) as RunSummary,
    );
    expect(text).toContain(`  ${all[TEXT_FILES_LIMIT - 1]}\n  ... and 3 more\n`);
    expect(text).not.toContain(`  ${all[TEXT_FILES_LIMIT]}\n`);
  });

  it("failed run: Drafts and logs, Next, and a Reason line with class and message", () => {
    const text = render(
      withLanding(summaryOf({ status: "failed", exit_code: 1 }), {
        merged: false,
        base_branch: "main",
        files: [],
        runFailed: true,
        needsInput: false,
        failure: { failure_class: "verify_failed", message: "npm test failed" },
      }) as RunSummary,
    );
    expect(text).toContain(`Drafts and logs: .substrate/runs/${RUN_ID}/\n`);
    // R10.4 (known issue 41, reversed): a failed run is resumed; the Next lines lead with the resume.
    expect(text).toContain("Next:       substrate resume ");
    expect(text).toContain("            Start a new run with a narrower request\n");
    expect(text).not.toContain("cannot be resumed");
    expect(text).toContain("Reason:     verify_failed: npm test failed\n");
    expect(text).not.toContain("Result:");
  });

  it("a summary without landing fields (a resumed run) prints no Result block", () => {
    const text = render(summaryOf());
    expect(text).not.toContain("Result:");
    expect(text).toContain("Merged:     no\n");
  });
});

describe("R7.4 json and stream-json summaries", () => {
  it("json: one object carries merged, branch, base_branch, files and next", () => {
    const out = sink();
    const formatter = createFormatter("json", out.stream);
    const summary = withLanding(summaryOf(), {
      merged: true,
      base_branch: "main",
      files: ["a.txt"],
      runFailed: false,
      needsInput: false,
    }) as RunSummary;
    formatter.onSummary(summary, "sess_test");
    const parsed = JSON.parse(out.text().trim());
    expect(parsed).toMatchObject({
      merged: true,
      branch: `substrate/runs/${RUN_ID}`,
      base_branch: "main",
      files_changed: ["a.txt"],
      files_changed_total: 1,
      next: [],
    });
  });

  it("stream-json: the final result carries the landing fields and the failure fields", () => {
    const out = sink();
    const formatter = createFormatter("stream-json", out.stream);
    const summary = withLanding(summaryOf({ status: "failed", exit_code: 1 }), {
      merged: false,
      base_branch: "main",
      files: [],
      runFailed: true,
      needsInput: false,
      failure: { failure_class: "timeout", message: "task T1 timed out" },
    }) as RunSummary;
    formatter.onSummary(summary, "sess_test");
    const lines = out.text().trim().split("\n");
    const result = JSON.parse(lines[lines.length - 1]);
    expect(result).toMatchObject({
      type: "result",
      branch: `substrate/runs/${RUN_ID}`,
      merged: false,
      base_branch: "main",
      files_changed: [],
      files_changed_total: 0,
      next: [`substrate resume ${RUN_ID}  (retries the failed tasks; passed tasks are kept)`, "Start a new run with a narrower request"],
      failure_class: "timeout",
      message: "task T1 timed out",
      drafts_dir: `.substrate/runs/${RUN_ID}`,
    });
  });
});
