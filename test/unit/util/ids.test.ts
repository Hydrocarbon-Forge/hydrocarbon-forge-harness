import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { assertTaskId, createRunId, isRunId, isTaskId } from "../../../src/util/index.js";

describe("util ids: RunId creation and TaskId enforcement", () => {
  it("createRunId returns r_ plus 12 base32 chars and validates against the RunId schema", () => {
    const id = createRunId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^r_[A-Z2-7]{12}$/);
    const parsed = (Contracts as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean } }>).RunId.safeParse(
      id,
    );
    expect(parsed.success).toBe(true);
  });

  it("createRunId is unique across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(createRunId());
    expect(seen.size).toBe(100);
  });

  it("isRunId accepts only the declared shape", () => {
    expect(isRunId("r_ABCDEFGHIJKL")).toBe(true);
    expect(isRunId("r_222222222222")).toBe(true);
    expect(isRunId("r_abcdef123456")).toBe(false);
    expect(isRunId("r_ABC")).toBe(false);
    expect(isRunId("r_ABCDEFGHIJKLM")).toBe(false);
    expect(isRunId("x_ABCDEFGHIJKL")).toBe(false);
    expect(isRunId("")).toBe(false);
    expect(isRunId(null)).toBe(false);
    expect(isRunId(undefined)).toBe(false);
    expect(isRunId(123)).toBe(false);
    expect(isRunId({})).toBe(false);
  });

  it("isTaskId enforces /^[A-Z][A-Za-z0-9_-]{0,31}$/", () => {
    expect(isTaskId("A")).toBe(true);
    expect(isTaskId("T1-foo_bar")).toBe(true);
    expect(isTaskId("Z0123456789abcdefABCDEF_-xyz12Q")).toBe(true);
    expect(isTaskId("a-lower")).toBe(false);
    expect(isTaskId("")).toBe(false);
    expect(isTaskId("A" + "x".repeat(32))).toBe(false);
    expect(isTaskId("A has space")).toBe(false);
    expect(isTaskId("A.dot")).toBe(false);
    expect(isTaskId("A/slash")).toBe(false);
    expect(isTaskId("1ABC")).toBe(false);
    expect(isTaskId(null)).toBe(false);
    expect(isTaskId(42)).toBe(false);
  });

  it("isTaskId agrees with the TaskId contract schema", () => {
    const TaskId = (Contracts as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean } }>).TaskId;
    const cases = ["A", "T1", "T1-foo", "a-bad", "", "A" + "x".repeat(32)];
    for (const c of cases) {
      expect(isTaskId(c)).toBe(TaskId.safeParse(c).success);
    }
  });

  it("TaskId boundary: 32 chars accepted, 33 rejected", () => {
    const ok32 = "A" + "x".repeat(31);
    const bad33 = "A" + "x".repeat(32);
    expect(ok32.length).toBe(32);
    expect(isTaskId(ok32)).toBe(true);
    expect(isTaskId(bad33)).toBe(false);
  });

  it("assertTaskId throws on invalid, passes through valid", () => {
    expect(() => assertTaskId("T1-ok")).not.toThrow();
    expect(() => assertTaskId("bad id")).toThrow();
    expect(() => assertTaskId("")).toThrow();
    expect(() => assertTaskId(null)).toThrow();
  });

  it("helpers are pure and never throw on untrusted input shapes", () => {
    expect(() => isRunId({ toString: "r_AAAAAAAAAAAA" })).not.toThrow();
    expect(() => isTaskId(["A"])).not.toThrow();
    expect(() => isTaskId("\0A\0")).not.toThrow();
  });
});
