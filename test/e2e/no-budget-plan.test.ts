import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R7.7: a task without a budget is not a plan error. Since 2026-10-23 no spend cap is
// passed: the worker's claude spawn gets no --max-budget-usd. The fake claude dialect appends each spawn's argv to FAKE_ARGV_LOG.

const CLAUDE_BIN = resolve(fileURLToPath(import.meta.url), "../../fixtures/fake-harness/bin/claude");
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };

function claudeWrapper(dir: string, argvLog: string): string {
  const wrapper = join(dir, "claude-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_ARGV_LOG='${argvLog}'\nexec '${CLAUDE_BIN}' "$@"\n`, { mode: 0o755 });
  return wrapper;
}

function argvsOf(argvLog: string): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
    .filter((argv) => !argv.includes("--version"));
}

function diagnostics(res: RunSubstrateResult): string {
  return `exit=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

// The taskSpec helper writes a budget block; removing it leaves a task with no budget.
function withoutBudget(spec: string): string {
  const out = spec.replace("budget:\n  max_usd: 0.5\n  max_turns: 12\n", "");
  if (out === spec) throw new Error("taskSpec budget block not found");
  return out;
}

describe("R7.7: a plan whose tasks have no budget", () => {
  it("lints without errors and runs every task with no spend cap passed to claude", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-r77-budget-"));
    const argvLog = join(dir, "argv.log");
    const claude = claudeWrapper(dir, argvLog);
    const t1 = withoutBudget(taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" }));
    const t2 = withoutBudget(taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" }));
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("No budgets", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
          { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" },
        ],
      },
      settings: {
        backends: { claude: { bin: claude } },
      },
      args: ["run", "--permission-mode", "bypassPermissions", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "Two tasks without budgets"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const lint = res.events.filter((e) => e.type === "plan.lint");
      expect(lint.length, diagnostics(res)).toBeGreaterThan(0);
      expect((lint[lint.length - 1].data as { valid: boolean }).valid, diagnostics(res)).toBe(true);
      expect(res.events.some((e) => e.type === "plan.rejected"), diagnostics(res)).toBe(false);
      const workerSpawns = argvsOf(argvLog).slice(1);
      expect(workerSpawns.length, diagnostics(res)).toBe(2);
      for (const argv of workerSpawns) {
        expect(argv, diagnostics(res)).not.toContain("--max-budget-usd");
      }
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
