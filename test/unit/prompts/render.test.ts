import { describe, expect, it } from "vitest";

import { render } from "../../../src/prompts/render.js";

describe("render (src/prompts/render.ts)", () => {
  it("replaces every occurrence of the same variable", () => {
    expect(render("{{a}} and {{a}} and {{a}}", { a: "x" })).toBe("x and x and x");
  });

  it("replaces multiple distinct variables", () => {
    expect(render("{{a}} / {{b}}", { a: "1", b: "2" })).toBe("1 / 2");
  });

  it("passes multi-line values through unchanged", () => {
    expect(render("List:\n{{list}}\nEnd", { list: "- x\n- y" })).toBe("List:\n- x\n- y\nEnd");
  });

  it("renders an empty value as (none)", () => {
    expect(render("run: {{run_id}}", { run_id: "" })).toBe("run: (none)");
  });

  it("renders a whitespace-only value as (none)", () => {
    expect(render("run: {{run_id}}", { run_id: "   \n  " })).toBe("run: (none)");
  });

  it("throws for a template variable the caller did not pass", () => {
    expect(() => render("{{nope}}", { other: "x" })).toThrow("missing template variable: nope");
    expect(() => render("a {{b}} c", {})).toThrow("missing template variable: b");
  });

  it("throws when a {{ survives substitution (unmatched token)", () => {
    expect(() => render("{{Name}}", { name: "x" })).toThrow("unrendered placeholder in template");
    expect(() => render("keep {{}}", {})).toThrow("unrendered placeholder in template");
  });

  it("throws when a substituted value leaves {{ behind", () => {
    expect(() => render("value: {{a}}", { a: "keep {{x}}" })).toThrow(
      "unrendered placeholder in template",
    );
  });
});
