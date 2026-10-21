import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R7.9: the planner is bounded by the run budget, not the per-task cap. The fake claude
// dialect appends each spawn's argv to FAKE_ARGV_LOG; --max-budget-usd is that spawn's cap.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "contracts/types.ts": CONTRACT_STUB };
const CLAUDE_BIN = resolve(fileURLToPath(import.meta.url), "../../fixtures/fake-harness/bin/claude");

function claudeWrapper(dir: string, argvLog: string): string {
  const wrapper = join(dir, "claude-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_ARGV_LOG='${argvLog}'\nexec '${CLAUDE_BIN}' "$@"\n`, { mode: 0o755 });
  return wrapper;
}

function realSpawnCaps(argvLog: string): Array<number | undefined> {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
    .filter((argv) => !argv.includes("--version"))
    .map((argv) => {
      const idx = argv.indexOf("--max-budget-usd");
      return idx >= 0 ? Number(argv[idx + 1]) : undefined;
    });
}

function diagnostics(res: RunSubstrateResult): string {
  return `exit=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

/** A planner reply whose manifest does not parse, so the planner retries; it costs `cost` USD. */
const REFUSED_PLAN = (cost: number) => ({
  plan: { files: { "manifest.yaml": "goal: [unclosed bracket\n" } },
  reply: "drafted the plan",
  cost_usd: cost,
});

describe("R7.9: the planner's spawn budget comes from the run budget", () => {
  it("the planner spawn gets the run budget and each task spawn gets the per-task cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-r79-cap-"));
    const argvLog = join(dir, "argv.log");
    const claude = claudeWrapper(dir, argvLog);
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Planner budget", ["T1"]), { "tasks/T1.md": t1 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
        ],
      },
      settings: { backends: { claude: { bin: claude } }, budgets: { run: { max_usd: 5 }, task: { max_usd: 0.5 } } },
      args: [...RUN_ARGS, "One task with budgets", "Planner budget case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const caps = realSpawnCaps(argvLog);
      expect(caps.length, diagnostics(res)).toBe(2);
      expect(caps[0]).toBe(5);
      expect(caps[1]).toBe(0.5);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a planner retry gets the run budget left after the refused attempt's spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-r79-retry-"));
    const argvLog = join(dir, "argv.log");
    const claude = claudeWrapper(dir, argvLog);
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          REFUSED_PLAN(1.5),
          planCall(contractFiles(manifestFor("Planner retry budget", ["T1"]), { "tasks/T1.md": t1 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
        ],
      },
      settings: { backends: { claude: { bin: claude } }, budgets: { run: { max_usd: 5 }, task: { max_usd: 0.5 } } },
      args: [...RUN_ARGS, "One task with a refused first plan", "Planner retry budget case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const caps = realSpawnCaps(argvLog);
      expect(caps.length, diagnostics(res)).toBe(3);
      expect(caps[0]).toBe(5);
      // The refused attempt cost 1.5 USD, so the retry is capped at what is left of the run budget.
      expect(caps[1]).toBeCloseTo(3.5, 6);
      expect(caps[2]).toBe(0.5);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
