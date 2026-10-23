import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// 2026-10-23 (owner, d): one task that fails for good is BLOCKED alone. Its dependent is skipped with the reason, an
// independent task still merges, the run ends with status `partial` (exit 1), and `resume` retries only the blocked
// task and the skipped dependent; the merged task is kept and never started again.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };
const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");
const LADDER = Array.from({ length: 14 }, () => ({ reply: "DONE" }));

function resume(res: RunSubstrateResult, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "substrate-partial-home-"));
  try {
    const out = spawnSync(process.execPath, [substrateMjs, "resume", ...args], {
      cwd: res.repoDir,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 60000,
    });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function eventsOf(res: RunSubstrateResult): Array<{ type: string; data: any }> {
  return readFileSync(join(res.runDir as string, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** T1 crashes on every attempt, T2 is independent and passes, T3 depends on T1. */
function partialRun(args: string[]): RunSubstrateResult {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  const t3 = taskSpec({ id: "T3", dependsOn: ["T1"], write: ["src/c.txt"], verify: "grep -q t3-done src/c.txt" });
  const crash = Array.from({ length: 3 }, () => ({ failure: "crash" }));
  return runSubstrate({
    files: SEED,
    scenario: {
      calls: [
        planCall(contractFiles(manifestFor("Partial success", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
        ...crash,
        { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" },
        ...LADDER,
      ],
    },
    args: [...RUN_ARGS, ...args],
  });
}

describe("2026-10-23 (d): a blocked task does not take the run down; resume retries only what did not pass", () => {
  it("the blocked task and its dependent are reported, the independent task merges, and the run is partial", () => {
    const res = partialRun(["--output-format", "json", "Partial success"]);
    try {
      expect(res.exitCode).toBe(1);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.status).toBe("partial");
      expect(summary.tasks.T1.state).toBe("FAILED");
      expect(summary.tasks.T2.state).toBe("PASSED");
      expect(summary.tasks.T3.state).toBe("SKIPPED");

      const events = eventsOf(res);
      expect(events.some((e) => e.type === "task.merged" && e.data.task_id === "T2")).toBe(true);
      const skipped = events.find((e) => e.type === "task.skipped" && e.data.task_id === "T3");
      expect(skipped?.data.failed).toEqual(["T1"]);
      expect(events.filter((e) => e.type === "run.finished")).toHaveLength(1);
      expect(events.find((e) => e.type === "run.finished")?.data).toMatchObject({ exit_code: 1, status: "partial" });
    } finally {
      res.cleanup();
    }
  });

  it("resume retries only the blocked task and its skipped dependent; the merged task is kept", () => {
    const res = partialRun(["Partial success resume"]);
    try {
      expect(res.exitCode).toBe(1);
      const before = eventsOf(res).length;
      const out = resume(res, [res.runDir?.split("/").at(-1) as string]);
      expect(out.stdout).toContain("retrying T1");
      expect(out.stdout).toContain("keeping T2");

      const after = eventsOf(res).slice(before);
      const reopened = after.find((e) => e.type === "run.reopened");
      expect(reopened?.data.failed_tasks).toContain("T1");
      expect(reopened?.data.failed_tasks).not.toContain("T2");
      expect(reopened?.data.kept_tasks ?? []).toContain("T2");

      const all = eventsOf(res);
      expect(all.filter((e) => e.type === "task.session.started" && e.data.task_id === "T2")).toHaveLength(1);
      // The blocked task is queued again (a new generation); the skipped dependent is released with it.
      expect(after.some((e) => e.type === "task.ready" && e.data.task_id === "T1")).toBe(true);
      expect(all.some((e) => e.type === "task.session.started" && e.data.task_id === "T1" && e.data.generation === 2)).toBe(true);
    } finally {
      res.cleanup();
    }
  });
});
