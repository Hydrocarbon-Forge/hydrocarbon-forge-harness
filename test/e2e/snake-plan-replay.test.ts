import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { planCall } from "./helpers/plan-scenario.js";

// R7.7: the attempt-2 plan of run r_XDZHITGE25FD ("make a snake game" in an empty repository)
// was refused by the contract typecheck at the LINTING step. The planner's files are replayed
// through the fake planner; the contract stubs are the real drafts, not placeholders.

const FIXTURE = resolve(fileURLToPath(import.meta.url), "../../fixtures/spec/snake-plan-2");
const PLAN_FILES = ["manifest.yaml", "package.json", "decisions.md", "tasks/T1.md", "tasks/T2.md", "tasks/T3.md", "src/game.js", "src/controls.js"];

function diagnostics(res: RunSubstrateResult): string {
  return `exit=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

describe("R7.7: the snake plan that the contract typecheck refused at LINTING", () => {
  it("plan mode: the replayed attempt-2 plan passes the approval lint", () => {
    const files: Record<string, string> = {};
    for (const rel of PLAN_FILES) files[rel] = readFileSync(join(FIXTURE, rel), "utf8");
    const res = runSubstrate({
      scenario: { calls: [planCall(files)] },
      args: ["plan", "--plan", "claude:claude-sonnet-5-5", "make a snake game"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const lint = res.events.filter((e) => e.type === "plan.lint");
      expect(lint.length, diagnostics(res)).toBeGreaterThan(0);
      expect((lint[lint.length - 1].data as { valid: boolean }).valid, diagnostics(res)).toBe(true);
      expect(res.events.some((e) => e.type === "plan.rejected"), diagnostics(res)).toBe(false);
    } finally {
      res.cleanup();
    }
  });
});
