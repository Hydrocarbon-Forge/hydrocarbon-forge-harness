import { describe, expect, it } from "vitest";

import { loadTemplate } from "../../../src/prompts/index.js";
import { render } from "../../../src/prompts/render.js";

// R12.4: the repair prompt is an asset (assets/prompts/worker/repair.md) rendered with the run's values. A check's
// output may hold `{{` (a template or a brace-heavy error), and the second attempt carries the first one's outcome.

const VARS = {
  attempt: "2",
  max_attempts: "2",
  request: "Make the snake game",
  check_command: "npm test",
  output_tail: "FAIL test/a.test.ts\n  expected {{ x: number }}",
  tasks: "T1: Move the snake\nT2: Draw the board",
  previous: "attempt 1 was rejected: it deletes test file test/a.test.ts",
};

describe("worker/repair.md (R12.4)", () => {
  it("is found among the built-in templates and names every variable the action passes", () => {
    const template = loadTemplate("worker/repair.md");
    for (const name of Object.keys(VARS)) {
      expect(template, name).toContain(`{{${name}}}`);
    }
  });

  it("renders the request, the check, the output tail, the merged tasks and the attempt", () => {
    const out = render(loadTemplate("worker/repair.md"), VARS);
    expect(out).toContain("repair attempt 2 of 2");
    expect(out).toContain("Make the snake game");
    expect(out).toContain("npm test");
    expect(out).toContain("expected {{ x: number }}");
    expect(out).toContain("T2: Draw the board");
  });

  it("carries the previous attempt's outcome for attempt 2", () => {
    const out = render(loadTemplate("worker/repair.md"), VARS);
    expect(out).toContain("attempt 1 was rejected: it deletes test file test/a.test.ts");
  });

  it("tells the worker the rules: fix the code, keep the check, and the CHECK-UNFIXABLE line", () => {
    const out = render(loadTemplate("worker/repair.md"), VARS);
    expect(out).toMatch(/Do not edit the check/);
    expect(out).toMatch(/Do not delete, rename or skip any test/);
    expect(out).toMatch(/CHECK-UNFIXABLE: <reason>/);
  });
});
