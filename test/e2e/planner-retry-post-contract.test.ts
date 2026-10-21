import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R7.7: a plan the contract stage refuses is a format rejection, and the planner is asked
// again (plan.format_rejected, "plan rejected (attempt k/3)") while attempts remain. The
// contract typecheck here is `node -e "process.exit(1)"`, which fails in the planner's
// own check; the approval lint runs before the contract stubs are committed.

const BAD_TYPECHECK = "node -e 'process.exit(1)'";
const ARGS = ["plan", "--plan", "claude:claude-sonnet-5-5", "Contracts that the typecheck refuses"];

function diagnostics(res: RunSubstrateResult): string {
  return `exit=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

function manifestWith(typecheck: string, extraContract?: string): string {
  let m = manifestFor("Contracts that the typecheck refuses", ["T1"]).replace("echo typecheck contracts", typecheck);
  if (extraContract) m = m.replace("    - contracts/types.ts\n", `    - contracts/types.ts\n    - ${extraContract}\n`);
  return m;
}

const T1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
const SEED = { "src/a.txt": "seed a\n", "contracts/types.ts": CONTRACT_STUB };

describe("R7.7: the planner is retried when the contract stage refuses its plan", () => {
  it("attempt 1 refused by the contract typecheck, attempt 2 good: the plan is ready", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestWith(BAD_TYPECHECK), { "tasks/T1.md": T1 })),
          planCall(contractFiles(manifestWith("echo typecheck contracts"), { "tasks/T1.md": T1 })),
        ],
      },
      args: ARGS,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const rejected = res.events.filter((e) => e.type === "plan.format_rejected");
      expect(rejected.map((e) => (e.data as { attempt: number }).attempt), diagnostics(res)).toEqual([1]);
      expect(res.stdout, diagnostics(res)).toContain("plan rejected (attempt 1/3)");
      expect(res.events.some((e) => e.type === "plan.ready"), diagnostics(res)).toBe(true);
      expect(res.events.some((e) => e.type === "plan.rejected"), diagnostics(res)).toBe(false);
    } finally {
      res.cleanup();
    }
  });

  it("every attempt refused: the run stops after the third attempt with its last message", () => {
    const bad = contractFiles(manifestWith(BAD_TYPECHECK), { "tasks/T1.md": T1 });
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [planCall(bad), planCall(bad), planCall(bad)] },
      args: ARGS,
    });
    try {
      expect(res.exitCode, diagnostics(res)).not.toBe(0);
      const rejected = res.events.filter((e) => e.type === "plan.format_rejected");
      expect(rejected.map((e) => (e.data as { attempt: number; max_attempts: number }).attempt), diagnostics(res)).toEqual([1, 2, 3]);
      expect(rejected.every((e) => (e.data as { max_attempts: number }).max_attempts === 3), diagnostics(res)).toBe(true);
      expect(res.stdout, diagnostics(res)).toContain("plan rejected (attempt 3/3)");
      const failed = res.events.find((e) => e.type === "task.failed");
      expect(String((failed?.data as { message?: string })?.message), diagnostics(res)).toContain("[L018]");
      expect(res.events.some((e) => e.type === "contracts.committed"), diagnostics(res)).toBe(false);
    } finally {
      res.cleanup();
    }
  });

  it("a refused attempt's contract stubs are not committed to the run branch", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestWith(BAD_TYPECHECK, "contracts/stale.ts"), { "tasks/T1.md": T1, "contracts/stale.ts": CONTRACT_STUB })),
          planCall(contractFiles(manifestWith("echo typecheck contracts"), { "tasks/T1.md": T1 })),
        ],
      },
      args: ARGS,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const runId = res.events[0].run_id;
      const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", `substrate/runs/${runId}`], {
        cwd: res.repoDir,
        encoding: "utf8",
      }).split("\n");
      expect(tree).toContain("contracts/types.ts");
      expect(tree, diagnostics(res)).not.toContain("contracts/stale.ts");
    } finally {
      res.cleanup();
      rmSync(res.repoDir, { recursive: true, force: true });
    }
  });
});
