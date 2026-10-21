import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R10.4 (known issue 41, reversed): a run that ended failed is resumed, not refused. `substrate resume`
// reopens it: the failed tasks retry as a new generation, the passed tasks are kept, and the skipped
// dependents return to the queue. A finished run still says it is finished (exit 0).
// These tests replace the R8.3 assertions that pinned `failure_class: not_resumable`.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };
const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");
/** claude's budget stop of the planner: a planning failure with no tasks (planner-failure-cause). */
const BUDGET_STOPPED_PLANNER = { failure: "budget", cost_usd: 0.55, reply: "" };
const LADDER = Array.from({ length: 14 }, () => ({ reply: "DONE" }));

function runIdOf(res: RunSubstrateResult): string {
  return res.runDir?.split("/").at(-1) as string;
}

function resume(res: RunSubstrateResult, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "substrate-resume-home-"));
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

/** T1 passes and T2 never does: the run fails with T1 on its branch and an integration verify in the plan. */
function partialFailure(args: string[]): RunSubstrateResult {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q never-there src/b.txt" });
  return runSubstrate({
    files: SEED,
    scenario: {
      calls: [
        planCall(contractFiles(manifestFor("Partial", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
        { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
        ...LADDER,
      ],
    },
    args: [...RUN_ARGS, ...args],
  });
}

describe("R10.4: a failed run is resumed; the failed tasks retry and the passed ones are kept", () => {
  it("resume reopens a failed run: T1 is kept, T2 is retried as a new generation, and the progress names both", () => {
    const res = partialFailure(["Partial failure"]);
    try {
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain(`Next:       substrate resume ${runIdOf(res)}  (retries the failed tasks; passed tasks are kept)`);
      const before = eventsOf(res).length;
      // No scripted worker calls remain, so the retried T2 fails again; the resume itself is what is tested.
      const out = resume(res, [runIdOf(res)]);
      expect(out.stdout).toContain(`resuming failed run ${runIdOf(res)}: retrying T2; keeping T1 (passed)`);
      expect(out.stdout).not.toContain("cannot be resumed");
      expect(out.stdout).not.toContain("already finished");
      const after = eventsOf(res).slice(before);
      expect(after.some((e) => e.type === "run.reopened" && e.data.reason === "tasks")).toBe(true);
      // T1 was merged in the first run and is not spawned again.
      expect(eventsOf(res).filter((e) => e.type === "task.session.started" && e.data.task_id === "T1")).toHaveLength(1);
    } finally {
      res.cleanup();
    }
  });

  it("json: the failed run's next lists the resume first, and a resume prints no failure_class", () => {
    const res = partialFailure(["--output-format", "json", "Partial failure json"]);
    try {
      expect(res.exitCode).toBe(1);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.next[0]).toBe(`substrate resume ${summary.run_id}  (retries the failed tasks; passed tasks are kept)`);
      expect(summary.next).toContain(`substrate merge ${summary.run_id} --partial  (lands the passed tasks after integration verify passes)`);
      const out = resume(res, [summary.run_id, "--output-format", "json"]);
      expect(out.stdout).not.toContain("not_resumable");
      expect(out.stderr).not.toContain("not_resumable");
    } finally {
      res.cleanup();
    }
  });

  it("a failed run with no passed task is reopened too: the task retries and the resume says so", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q never-there src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Narrow", ["T1"]), { "tasks/T1.md": t1 })),
          ...LADDER,
        ],
      },
      args: [...RUN_ARGS, "--output-format", "json", "Narrow failure"],
    });
    try {
      expect(res.exitCode).toBe(1);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.next[0]).toBe(`substrate resume ${summary.run_id}  (retries the failed tasks; passed tasks are kept)`);
      expect(summary.next).toContain("Start a new run with a narrower request");
      const out = resume(res, [summary.run_id]);
      expect(out.stdout).toContain(`resuming failed run ${summary.run_id}: retrying T1`);
      expect(out.stdout).not.toContain("keeping");
      expect(out.stdout).not.toContain("cannot be resumed");
    } finally {
      res.cleanup();
    }
  });

  it("a failed planning run is planned again on resume, with the cost named", () => {
    const res = runSubstrate({
      files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
      scenario: { calls: [BUDGET_STOPPED_PLANNER] },
      args: ["run", "--mode", "plan", "--permission-mode", "plan", "Planning failure"],
    });
    try {
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain(`Next:       substrate resume ${runIdOf(res)}  (plans again; planning costs again)`);
      expect(res.stdout).not.toContain("Run substrate run again");
      const out = resume(res, [runIdOf(res)]);
      expect(out.stdout).toContain("no plan was accepted; planning again (planning costs again)");
      expect(out.stdout).not.toContain("cannot be resumed");
    } finally {
      res.cleanup();
    }
  });

  it("a finished run still says it is already finished, with exit 0", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Finished", ["T1"]), { "tasks/T1.md": t1 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
        ],
      },
      args: [...RUN_ARGS, "Finished run"],
    });
    try {
      expect(res.exitCode).toBe(0);
      const out = resume(res, [runIdOf(res)]);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain(`Run ${runIdOf(res)} is already finished. Nothing to resume.`);
    } finally {
      res.cleanup();
    }
  });
});
