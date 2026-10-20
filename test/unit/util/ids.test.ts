import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";

// The contract schemas are the live validators (the util helpers they replaced are removed).
type SchemaLike = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };
const contractSchemas = Contracts as unknown as Record<string, SchemaLike>;
const RunIdSchema = contractSchemas.RunId;
const TaskIdSchema = contractSchemas.TaskId;
const runIdAccepts = (v: unknown): boolean => RunIdSchema.safeParse(v).success;
const taskIdAccepts = (v: unknown): boolean => TaskIdSchema.safeParse(v).success;

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

  it("RunId schema accepts only the declared shape", () => {
    expect(runIdAccepts("r_ABCDEFGHIJKL")).toBe(true);
    expect(runIdAccepts("r_222222222222")).toBe(true);
    expect(runIdAccepts("r_abcdef123456")).toBe(false);
    expect(runIdAccepts("r_ABC")).toBe(false);
    expect(runIdAccepts("r_ABCDEFGHIJKLM")).toBe(false);
    expect(runIdAccepts("x_ABCDEFGHIJKL")).toBe(false);
    expect(runIdAccepts("")).toBe(false);
    expect(runIdAccepts(null)).toBe(false);
    expect(runIdAccepts(undefined)).toBe(false);
    expect(runIdAccepts(123)).toBe(false);
    expect(runIdAccepts({})).toBe(false);
  });

  it("TaskId schema enforces /^[A-Z][A-Za-z0-9_-]{0,31}$/", () => {
    expect(taskIdAccepts("A")).toBe(true);
    expect(taskIdAccepts("T1-foo_bar")).toBe(true);
    expect(taskIdAccepts("Z0123456789abcdefABCDEF_-xyz12Q")).toBe(true);
    expect(taskIdAccepts("a-lower")).toBe(false);
    expect(taskIdAccepts("")).toBe(false);
    expect(taskIdAccepts("A" + "x".repeat(32))).toBe(false);
    expect(taskIdAccepts("A has space")).toBe(false);
    expect(taskIdAccepts("A.dot")).toBe(false);
    expect(taskIdAccepts("A/slash")).toBe(false);
    expect(taskIdAccepts("1ABC")).toBe(false);
    expect(taskIdAccepts(null)).toBe(false);
    expect(taskIdAccepts(42)).toBe(false);
  });

  it("TaskId schema agrees with the TaskId contract schema", () => {
    const TaskId = (Contracts as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean } }>).TaskId;
    const cases = ["A", "T1", "T1-foo", "a-bad", "", "A" + "x".repeat(32)];
    for (const c of cases) {
      expect(taskIdAccepts(c)).toBe(TaskId.safeParse(c).success);
    }
  });

  it("TaskId boundary: 32 chars accepted, 33 rejected", () => {
    const ok32 = "A" + "x".repeat(31);
    const bad33 = "A" + "x".repeat(32);
    expect(ok32.length).toBe(32);
    expect(taskIdAccepts(ok32)).toBe(true);
    expect(taskIdAccepts(bad33)).toBe(false);
  });

  it("TaskId schema parse throws on invalid, passes through valid", () => {
    expect(() => TaskIdSchema.parse("T1-ok")).not.toThrow();
    expect(() => TaskIdSchema.parse("bad id")).toThrow();
    expect(() => TaskIdSchema.parse("")).toThrow();
    expect(() => TaskIdSchema.parse(null)).toThrow();
  });

  it("helpers are pure and never throw on untrusted input shapes", () => {
    expect(() => runIdAccepts({ toString: "r_AAAAAAAAAAAA" })).not.toThrow();
    expect(() => taskIdAccepts(["A"])).not.toThrow();
    expect(() => taskIdAccepts("\0A\0")).not.toThrow();
  });
});
