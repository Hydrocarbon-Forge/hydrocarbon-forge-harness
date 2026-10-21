import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R12.3: a contract typecheck that fails is a warning (rule L018), not a format rejection. The planner's
// first plan is accepted, no retry is spent, and the stubs it wrote are committed with the plan. The
// typecheck here is `node -e "process.exit(1)"`, which fails in the planner's own check.

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

describe("R12.3: a failing contract typecheck is a warning, not a format rejection", () => {
  it("the first plan is accepted: no retry, no plan.format_rejected, the plan is ready", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [planCall(contractFiles(manifestWith(BAD_TYPECHECK), { "tasks/T1.md": T1 }))],
      },
      args: ARGS,
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      expect(res.events.filter((e) => e.type === "plan.format_rejected"), diagnostics(res)).toEqual([]);
      expect(res.stdout, diagnostics(res)).not.toContain("plan rejected");
      expect(res.events.some((e) => e.type === "plan.ready"), diagnostics(res)).toBe(true);
      expect(res.events.some((e) => e.type === "plan.rejected"), diagnostics(res)).toBe(false);
    } finally {
      res.cleanup();
    }
  });

  it("the stubs of a plan whose typecheck fails are committed with the plan", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestWith(BAD_TYPECHECK, "contracts/stale.ts"), { "tasks/T1.md": T1, "contracts/stale.ts": CONTRACT_STUB })),
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
      expect(tree, diagnostics(res)).toContain("contracts/stale.ts");
    } finally {
      res.cleanup();
      rmSync(res.repoDir, { recursive: true, force: true });
    }
  });
});
