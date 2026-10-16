import { describe, expect, it } from "vitest";

import {
  evaluatePermission,
  evaluateWorkerPermission,
  matchPermissionRule,
  parsePermissionRule,
} from "../../../src/config/index.js";

describe("config permission rules: Claude Tool(spec) matcher", () => {
  it("parses the plan §4.4 forms", () => {
    expect(parsePermissionRule("Bash(git *)")).toEqual({ tool: "Bash", pattern: "git *" });
    expect(parsePermissionRule("Edit(src/**)")).toEqual({ tool: "Edit", pattern: "src/**" });
    expect(parsePermissionRule("mcp__s__t")).toEqual({ tool: "mcp__s__t", pattern: null });
    expect(parsePermissionRule("Agent")).toEqual({ tool: "Agent", pattern: null });
  });

  it("matches tool calls against rules", () => {
    expect(matchPermissionRule("Bash(git *)", "Bash(git status)")).toBe(true);
    expect(matchPermissionRule("Bash(git *)", "Bash(npm test)")).toBe(false);
    expect(matchPermissionRule("Edit(src/**)", "Edit(src/a/b.ts)")).toBe(true);
    expect(matchPermissionRule("Edit(src/**)", "Edit(other/a.ts)")).toBe(false);
    expect(matchPermissionRule("mcp__s__t", "mcp__s__t")).toBe(true);
    expect(matchPermissionRule("mcp__s__t", "mcp__s__other")).toBe(false);
    expect(matchPermissionRule("Agent", "Agent(anything)")).toBe(true);
  });

  it("deny beats ask beats allow", () => {
    const perms = {
      allow: ["Bash(git *)"],
      ask: ["Bash(git *)"],
      deny: ["Bash(git commit*)"],
    };
    expect(evaluatePermission("Bash(git status)", perms)).toBe("ask");
    expect(evaluatePermission("Bash(git commit -m x)", perms)).toBe("deny");
    expect(evaluatePermission("Bash(npm test)", { allow: ["Bash(*)"] })).toBe("allow");
  });

  it("allow-only match allows; ask-only match asks", () => {
    expect(evaluatePermission("Edit(src/a.ts)", { allow: ["Edit(src/**)"], deny: [] })).toBe(
      "allow",
    );
    expect(
      evaluatePermission("Edit(src/a.ts)", { allow: [], deny: [], ask: ["Edit(src/**)"] }),
    ).toBe("ask");
  });

  it("default-denies worker-dangerous tools with no matching rule", () => {
    const empty = { allow: [] as string[], deny: [] as string[] };
    expect(evaluatePermission("Agent(spawn)", empty)).toBe("deny");
    expect(evaluatePermission("Bash(git commit -m x)", empty)).toBe("deny");
    expect(evaluatePermission("Bash(git push)", empty)).toBe("deny");
    expect(evaluatePermission("Bash(git checkout main)", empty)).toBe("deny");
    expect(evaluatePermission("WebFetch(https://example.com)", empty)).toBe("deny");
  });

  it("workers treat ask as deny downstream", () => {
    expect(
      evaluateWorkerPermission("Edit(src/a.ts)", {
        allow: [],
        deny: [],
        ask: ["Edit(src/**)"],
      }),
    ).toBe("deny");
    expect(
      evaluateWorkerPermission("Edit(src/a.ts)", {
        allow: ["Edit(src/**)"],
        deny: [],
      }),
    ).toBe("allow");
    expect(
      evaluateWorkerPermission("Bash(git commit -m x)", {
        allow: ["Bash(git *)"],
        deny: ["Bash(git commit*)"],
      }),
    ).toBe("deny");
  });

  it("rejects malformed rules instead of silently allowing", () => {
    expect(() => parsePermissionRule("Bash(")).toThrow();
    expect(() => parsePermissionRule("")).toThrow();
  });
});
