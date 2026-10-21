import { describe, expect, it } from "vitest";

import { FailureClass, type FailurePacket } from "../../../src/contracts/index.js";
import { loadTemplate } from "../../../src/prompts/index.js";
import { render } from "../../../src/prompts/render.js";
import { buildCorrectionPrompt, buildPlannerPrompt } from "../../../src/roles/prompts/planner.js";
import { buildReplanL2Prompt, buildReplanPrompt } from "../../../src/roles/prompts/replan.js";
import { buildReviewerPrompt } from "../../../src/roles/prompts/reviewer.js";

// R9.1 (known issue 45 cause): a replan failed with "unrendered placeholder in template" because a
// contract stub holds a JSDoc type `{{ x: number }}` and the contracts go into replan-l2.md. Every
// prompt is rendered here with the variables its call site supplies, for each failure class, and
// with values that hold `{{`. A template that names a variable the call site does not supply fails
// render ("missing template variable"), so this also checks each template against its call site.

const CONTRACT_WITH_BRACES = "/**\n * @typedef {{ x: number, y: number }} Point\n */\nexport {};\n";
const LEFTOVER = /\{\{[a-z_]+\}\}/;

function packetFor(failureClass: FailureClass): FailurePacket {
  return {
    run_id: "r_ABCDEF234567",
    task_id: "T1",
    generation: 1,
    failure_class: failureClass,
    spec_path: "tasks/T1.md",
    attempts: [],
    diff: { stat: "1 file changed, 2 insertions(+)", patch_path: "runs/r_ABCDEF234567/diff.patch", truncated: false },
    verify_output: [
      {
        cmd: "node --test test/game.test.js",
        exit_code: 1,
        timed_out: false,
        duration_ms: 240,
        stdout_tail: "not ok 1 - {{ placeholder-like text }}",
        stderr_tail: "Error: expected {{ x }}",
        truncated: false,
      },
    ],
    scope_violations: failureClass === "scope_violation" ? ["src/other.js"] : [],
    worker_summary: "I changed the file {{ and stopped }}.",
    related_contracts: ["src/game.js"],
    dependents: ["T2"],
  };
}

describe("replan prompts render for every failure class (R9.1)", () => {
  for (const failureClass of FailureClass.options) {
    it(`L1 replan renders for ${failureClass}`, () => {
      const prompt = buildReplanPrompt(packetFor(failureClass), "- decision {{ kept }}", {
        task_spec: "spec with {{ braces }}",
      });
      expect(prompt.user).toContain(failureClass);
      expect(prompt.user).not.toMatch(LEFTOVER);
    });

    it(`L2 replan renders for ${failureClass} with contracts that hold {{`, () => {
      const prompt = buildReplanL2Prompt(packetFor(failureClass), {
        escalation_reason: "integration_failed: node --test exited 1",
        manifest: "integration_verify:\n  - run: node --test test/game.test.js\n",
        task_states: "- T1: FAILED\n- T2: PENDING",
        contracts: CONTRACT_WITH_BRACES,
        decisions: "- kept {{ x }}",
      });
      expect(prompt.user).toContain("{{ x: number, y: number }}");
      expect(prompt.user).not.toMatch(LEFTOVER);
    });
  }

  it("the planner, correction, reviewer and worker templates render with values that hold {{", () => {
    const planner = buildPlannerPrompt({ request: "make {{ a snake }} game", repoMap: CONTRACT_WITH_BRACES });
    expect(planner.user).not.toMatch(LEFTOVER);
    const correction = buildCorrectionPrompt({ attempt: 1, max_attempts: 3, diagnostics: ["bad {{ x }}"] });
    expect(correction.user).not.toMatch(LEFTOVER);
    const reviewer = buildReviewerPrompt(CONTRACT_WITH_BRACES, ["src/game.js"]);
    expect(reviewer.user).not.toMatch(LEFTOVER);
    const worker = render(loadTemplate("worker/task.md"), { spec_path: "tasks/T1.md" });
    expect(worker).not.toMatch(LEFTOVER);
    const heal = render(loadTemplate("worker/heal.md"), { failures: CONTRACT_WITH_BRACES });
    expect(heal).toContain("{{ x: number, y: number }}");
    expect(heal).not.toMatch(LEFTOVER);
  });
});
