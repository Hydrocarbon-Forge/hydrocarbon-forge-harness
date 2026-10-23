import { describe, expect, it } from "vitest";
import { deepMerge } from "../../../src/util/merge.js";

describe("deepMerge", () => {
  it("merges plain objects recursively while keeping nested keys", () => {
    const base = {
      budgets: {
      },
      roles: {
        planner: { backend: "claude", model: "sonnet" },
      },
    };
    const overlay = {
      budgets: {
      },
      roles: {
        worker: { backend: "claude", model: "haiku" },
      },
    };

    const result = deepMerge(base, overlay);

    expect(result).toEqual({
      budgets: {
      },
      roles: {
        planner: { backend: "claude", model: "sonnet" },
        worker: { backend: "claude", model: "haiku" },
      },
    });
  });

  it("replaces arrays in base with arrays in overlay", () => {
    const base = {
      permissions: {
        allow: ["Read", "Write"],
        deny: ["Bash"],
      },
    };
    const overlay = {
      permissions: {
        allow: ["Glob"],
      },
    };

    const result = deepMerge(base, overlay);

    expect(result.permissions.allow).toEqual(["Glob"]);
    expect(result.permissions.deny).toEqual(["Bash"]);
  });

  it("replaces primitives in base with primitives in overlay", () => {
    const base = { a: 1, b: "hello", c: true };
    const overlay = { a: 2, b: "world", c: false };

    expect(deepMerge(base, overlay)).toEqual({ a: 2, b: "world", c: false });
  });

  it("ignores undefined values in overlay", () => {
    const base = { a: 1, b: { c: 2 } };
    const overlay = { a: undefined, b: { c: undefined } };

    expect(deepMerge(base, overlay)).toEqual({ a: 1, b: { c: 2 } });
  });

  it("replaces base value with null in overlay", () => {
    const base = { a: 1, b: { c: 2 } };
    const overlay = { a: null, b: null };

    expect(deepMerge(base, overlay)).toEqual({ a: null, b: null });
  });

  it("never mutates its arguments", () => {
    const base = {
      nested: { x: 1 },
      arr: [1, 2],
    };
    const overlay = {
      nested: { y: 2 },
      arr: [3],
    };

    const baseSnapshot = JSON.stringify(base);
    const overlaySnapshot = JSON.stringify(overlay);

    const result = deepMerge(base, overlay);

    expect(JSON.stringify(base)).toBe(baseSnapshot);
    expect(JSON.stringify(overlay)).toBe(overlaySnapshot);

    // Mutating result does not affect base or overlay
    result.nested.x = 99;
    result.arr.push(4);
    expect(base.nested.x).toBe(1);
    expect(overlay.arr).toEqual([3]);
  });

  it("handles undefined base or overlay gracefully", () => {
    const obj = { a: 1 };
    expect(deepMerge(obj, undefined)).toEqual({ a: 1 });
    expect(deepMerge(undefined, obj)).toEqual({ a: 1 });
    expect(deepMerge(undefined, undefined)).toBeUndefined();
  });
});
