import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// Known issue 41: a run that ended failed is not resumable, because the engine drops failed tasks by
// design. `substrate resume` refuses it (exit 1, failure_class not_resumable) and the summary names what
// to do instead. A finished run still says it is finished (exit 0).

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

function eventCount(res: RunSubstrateResult): number {
  return readFileSync(join(res.runDir as string, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length;
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

describe("known issue 41: a failed run is not resumable, and says what to do instead", () => {
  it("resume refuses a failed run with exit 1 and names the partial landing; the log is not touched", () => {
    const res = partialFailure(["Partial failure"]);
    try {
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("Next:       substrate merge " + runIdOf(res) + " --partial  (lands the passed tasks after integration verify passes)");
      const before = eventCount(res);
      const out = resume(res, [runIdOf(res)]);
      expect(out.status, out.stderr).toBe(1);
      expect(out.stdout).toContain(
        `Run ${runIdOf(res)} failed and cannot be resumed. Land the passed tasks with: substrate merge ${runIdOf(res)} --partial`,
      );
      expect(out.stdout).not.toContain("already finished");
      expect(eventCount(res)).toBe(before);
    } finally {
      res.cleanup();
    }
  });

  it("json: the refusal is an error object with failure_class not_resumable, and the json summary's next names only the partial landing", () => {
    const res = partialFailure(["--output-format", "json", "Partial failure json"]);
    try {
      expect(res.exitCode).toBe(1);
      const summary = JSON.parse(res.stdout.trim());
      expect(summary.next).toEqual([`substrate merge ${summary.run_id} --partial`]);
      expect(summary.next.some((c: string) => c.startsWith("substrate resume"))).toBe(false);
      const out = resume(res, [summary.run_id, "--output-format", "json"]);
      expect(out.status, out.stderr).toBe(1);
      const refusal = JSON.parse(out.stdout.trim());
      expect(refusal.failure_class).toBe("not_resumable");
      expect(refusal.error).toContain(`Run ${summary.run_id} failed and cannot be resumed.`);
    } finally {
      res.cleanup();
    }
  });

  it("a failed run with no passed task says to start a new run with a narrower request; resume refuses it too", () => {
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
      expect(summary.next).toEqual([]);
      const out = resume(res, [summary.run_id]);
      expect(out.status).toBe(1);
      expect(out.stdout).toContain(`Run ${summary.run_id} failed and cannot be resumed. Start a new run with a narrower request.`);
    } finally {
      res.cleanup();
    }
  });

  it("a failed planning run says to run substrate again (planning costs again); resume refuses it", () => {
    const res = runSubstrate({
      files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
      scenario: { calls: [BUDGET_STOPPED_PLANNER] },
      args: ["run", "--mode", "plan", "--permission-mode", "plan", "Planning failure"],
    });
    try {
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("Next:       Run substrate run again (planning costs again)");
      expect(res.stdout).not.toContain("substrate resume");
      const out = resume(res, [runIdOf(res)]);
      expect(out.status).toBe(1);
      expect(out.stdout).toContain(`Run ${runIdOf(res)} failed and cannot be resumed. Run substrate run again (planning costs again).`);
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
