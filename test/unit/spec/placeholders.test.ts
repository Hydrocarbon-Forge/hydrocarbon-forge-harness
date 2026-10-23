import { describe, expect, it } from "vitest";
import { findPlaceholders } from "../../../src/spec/placeholders.js";

describe("placeholder detection (L013)", () => {
  it("flags real markers TODO, FIXME and TBD as whole words in prose", () => {
    expect(findPlaceholders("Decide the type: TODO before the run.").map((f) => f.token)).toEqual(["TODO"]);
    expect(findPlaceholders("FIXME: handle empty input").map((f) => f.token)).toEqual(["FIXME"]);
    expect(findPlaceholders("The limit is TBD").map((f) => f.token)).toEqual(["TBD"]);
  });

  it("does not flag lowercase prose or words that only contain a marker", () => {
    expect(findPlaceholders("Keep a todo list of open items")).toEqual([]);
    expect(findPlaceholders("The TODOS file and FIXMEs elsewhere")).toEqual([]);
  });

  it("flags an angle-bracket placeholder token", () => {
    expect(findPlaceholders("Write the name as <placeholder> here").map((f) => f.token)).toEqual(["<placeholder>"]);
  });

  it("does not flag a bare ellipsis inside a sentence", () => {
    expect(findPlaceholders("Service unreachable, retrying...")).toEqual([]);
    expect(findPlaceholders("Loading the next page...and then stop")).toEqual([]);
  });

  it("flags an ellipsis that is the whole content of a line or bullet", () => {
    expect(findPlaceholders("...").map((f) => f.token)).toEqual(["..."]);
    expect(findPlaceholders("- Step one\n- ...").map((f) => f.token)).toEqual(["..."]);
    expect(findPlaceholders("1. ...").map((f) => f.token)).toEqual(["..."]);
  });

  it("flags a literal etc... stub", () => {
    expect(findPlaceholders("Handle the cases: a, b, etc...").map((f) => f.token)).toEqual(["etc..."]);
  });

  it("ignores call shorthand in inline code spans and anything inside code fences", () => {
    expect(findPlaceholders("Call `writeHash(..., {push: false})` once.")).toEqual([]);
    expect(findPlaceholders("```ts\n// TODO: type signature\n...\n```")).toEqual([]);
  });

  it("reports the offending line text for the warning", () => {
    const [finding] = findPlaceholders("Intro line\nThe return type is TODO for now");
    expect(finding.token).toBe("TODO");
    expect(finding.text).toBe("The return type is TODO for now");
  });
});
