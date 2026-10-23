import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// 2026-10-23 (owner, item 88): task A's check reads a file that task B owns. A is the first task to run, so it fails
// before B has merged. Its failure is routed to B (defer): A waits, B runs and merges, and A runs again and passes.

const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions", "--output-format", "json", "Owner routing"];

interface EventRow {
  type: string;
  data: any;
}

function eventsOf(res: RunSubstrateResult): EventRow[] {
  return readFileSync(join(res.runDir as string, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function ownerRoutedRun(): RunSubstrateResult {
  const a = taskSpec({ id: "A", write: ["src/a.txt"], verify: "grep -q b-done src/b.txt" });
  const b = taskSpec({ id: "B", write: ["src/b.txt"], verify: "grep -q b-done src/b.txt" });
  return runSubstrate({
    files: SEED,
    scenario: {
      calls: [
        planCall(contractFiles(manifestFor("Owner routing", ["A", "B"]), { "tasks/A.md": a, "tasks/B.md": b })),
        // A: the first attempt, the one L0 heal, then the attempt after the routing (generation 2).
        { task: "A", edits: { "src/a.txt": "seed a\na-wrote\n" }, reply: "DONE" },
        { task: "A", reply: "DONE" },
        { task: "A", edits: { "src/a.txt": "seed a\na-wrote\na-ok\n" }, reply: "DONE" },
        // B owns the file the check reads; it merges first.
        { task: "B", edits: { "src/b.txt": "seed b\nb-done\n" }, reply: "DONE" },
        ...Array.from({ length: 6 }, () => ({ reply: "DONE" })),
      ],
    },
    args: [...RUN_ARGS],
  });
}

describe("2026-10-23 (item 88): a failure in another task's files is routed to the owner", () => {
  it("A waits for B, B merges, A passes at generation 2, and the run succeeds", () => {
    const res = ownerRoutedRun();
    try {
      expect(res.exitCode).toBe(0);
      const events = eventsOf(res);

      const routed = events.find((e) => e.type === "plan.synced" && e.data.owner_route !== undefined);
      expect(routed?.data).toMatchObject({
        replan_task_id: "A",
        owner_route: { kind: "defer", owner: "B", files: ["src/b.txt"] },
      });

      const merged = events.filter((e) => e.type === "task.merged").map((e) => e.data.task_id);
      expect(merged).toEqual(["B", "A"]);

      expect(events.some((e) => e.type === "task.session.started" && e.data.task_id === "A" && e.data.generation === 2)).toBe(true);
      expect(events.some((e) => e.type === "replan.l2")).toBe(false);
      expect(events.find((e) => e.type === "run.finished")?.data).toMatchObject({ exit_code: 0 });
    } finally {
      res.cleanup();
    }
  });
});

// 2026-10-23 (owner, item 88): the owner has already merged when the failure shows. A depends on B, B merges a file
// that fails A's check, and A's failure is routed to B as a fix: a new task B-FIX1 owns the failing file, runs after B,
// and A waits for it. B-FIX1 makes the check pass, A runs again at generation 2 and passes, and the run succeeds.

function fixRoutedRun(): RunSubstrateResult {
  const a = taskSpec({ id: "A", dependsOn: ["B"], write: ["src/a.txt"], verify: "grep -q b-ok src/b.txt" });
  const b = taskSpec({ id: "B", write: ["src/b.txt"], verify: "grep -q b-done src/b.txt" });
  return runSubstrate({
    files: SEED,
    scenario: {
      calls: [
        planCall(contractFiles(manifestFor("Fix routing", ["A", "B"]), { "tasks/A.md": a, "tasks/B.md": b })),
        // B merges first; its file does not yet carry the marker A's check reads.
        { task: "B", edits: { "src/b.txt": "seed b\nb-done\n" }, reply: "DONE" },
        // A's first attempt fails on src/b.txt, which B owns and has merged. The one L0 heal runs first (A's second
        // call), then the failure is routed: the route is a fix task.
        { task: "A", edits: { "src/a.txt": "seed a\na-wrote\n" }, reply: "DONE" },
        { task: "A", reply: "DONE" },
        // The fix task owns src/b.txt and adds the marker.
        { task: "B-FIX1", edits: { "src/b.txt": "seed b\nb-done\nb-ok\n" }, reply: "DONE" },
        // A's attempt at generation 2 passes, now that the fix has merged.
        { task: "A", edits: { "src/a.txt": "seed a\na-wrote\na-ok\n" }, reply: "DONE" },
      ],
    },
    args: [...RUN_ARGS, "Fix routing"],
  });
}

describe("2026-10-23 (item 88): a failure after the owner has merged gets a fix task", () => {
  it("B-FIX1 owns the failing file, merges before A, A passes at generation 2, and the run succeeds", () => {
    const res = fixRoutedRun();
    try {
      expect(res.exitCode).toBe(0);
      const events = eventsOf(res);

      const routed = events.find((e) => e.type === "plan.synced" && e.data.owner_route !== undefined);
      expect(routed?.data).toMatchObject({
        replan_task_id: "A",
        owner_route: { kind: "fix", owner: "B", files: ["src/b.txt"], fix_task: "B-FIX1" },
      });

      const merged = events.filter((e) => e.type === "task.merged").map((e) => e.data.task_id);
      expect(merged).toEqual(["B", "B-FIX1", "A"]);

      expect(events.some((e) => e.type === "task.session.started" && e.data.task_id === "A" && e.data.generation === 2)).toBe(true);
      expect(events.some((e) => e.type === "replan.l2")).toBe(false);
      expect(events.find((e) => e.type === "run.finished")?.data).toMatchObject({ exit_code: 0 });
    } finally {
      res.cleanup();
    }
  });
});
