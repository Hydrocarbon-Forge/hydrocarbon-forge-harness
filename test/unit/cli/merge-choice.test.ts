import { describe, it, expect } from "vitest";

import { mergeChoiceOf, mergeFlagsConflict } from "../../../src/cli/commands/run.js";
import { parseCliArgs } from "../../../src/cli/dispatcher.js";
import { MERGE_TURNED_OFF_REASON, startBranchOf } from "../../../src/engine/landing.js";

// R10.1: the landing choice. The flag wins over the request field; with neither, the project
// setting (default true) decides, so these helpers return undefined and the caller reads the setting.

describe("R10.1: the landing choice", () => {
  it("--merge and --no-merge set the choice; with neither the choice is undefined", () => {
    expect(mergeChoiceOf({ merge: true })).toBe(true);
    expect(mergeChoiceOf({ noMerge: true })).toBe(false);
    expect(mergeChoiceOf({})).toBeUndefined();
  });

  it("a flag beats the request field, and the request field beats the setting", () => {
    expect(mergeChoiceOf({ merge: true }, false)).toBe(true);
    expect(mergeChoiceOf({ noMerge: true }, true)).toBe(false);
    expect(mergeChoiceOf({}, false)).toBe(false);
    expect(mergeChoiceOf({}, true)).toBe(true);
  });

  it("--merge together with --no-merge is refused; either one alone is not", () => {
    expect(mergeFlagsConflict({ merge: true, noMerge: true })).toBe("Error: --merge and --no-merge cannot be used together\n");
    expect(mergeFlagsConflict({ merge: true })).toBeUndefined();
    expect(mergeFlagsConflict({ noMerge: true })).toBeUndefined();
  });

  it("the dispatcher reads --no-merge into noMerge, and leaves --merge alone", () => {
    expect(parseCliArgs(["run", "--no-merge", "a goal"]).flags.noMerge).toBe(true);
    expect(parseCliArgs(["run", "--merge", "a goal"]).flags.noMerge).toBeUndefined();
    expect(parseCliArgs(["run", "--merge", "a goal"]).flags.merge).toBe(true);
  });

  it("the start branch is read from run.created, and is undefined for a run that recorded none", () => {
    expect(startBranchOf([{ type: "run.created", data: { base_branch: "main" } }])).toBe("main");
    expect(startBranchOf([{ type: "run.created", data: {} }])).toBeUndefined();
    expect(startBranchOf([{ type: "run.routed", data: { base_branch: "main" } }])).toBeUndefined();
  });

  it("the opt-out reason is the sentence the summary prints", () => {
    expect(MERGE_TURNED_OFF_REASON).toBe("not merged: merging was turned off");
  });
});
