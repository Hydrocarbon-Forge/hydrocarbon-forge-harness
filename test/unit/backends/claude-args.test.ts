import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "../../../src/backends/adapters/claude.js";
import { extractClaudeUsage } from "../../../src/backends/normalize/claude.js";
import type { SpawnRequest } from "../../../src/contracts/index.js";

describe("Claude Argument Builder: buildClaudeArgs", () => {
  const baseReq: SpawnRequest = {
    role: "worker",
    cwd: "/worktree/repo",
    prompt: "run task",
    model: "claude-haiku-5-5",
    permission: { allow: [], deny: [] },
    budget: { timeout_ms: 10000 },
    session: { id: "12345678-1234-1234-1234-123456789abc" },
  };

  it("rejects undefined or missing session id", () => {
    const req = { ...baseReq, session: undefined };
    expect(() => buildClaudeArgs(req as any)).toThrowError(
      "claude session id must be a UUID: undefined"
    );
  });

  it("rejects non-UUID session.id", () => {
    const req: SpawnRequest = {
      ...baseReq,
      session: { id: "not-a-valid-uuid" },
    };
    expect(() => buildClaudeArgs(req)).toThrowError(
      "claude session id must be a UUID: not-a-valid-uuid"
    );
  });

  it("rejects non-UUID session.resume", () => {
    const req: SpawnRequest = {
      ...baseReq,
      session: { resume: "session-123-abc" },
    };
    expect(() => buildClaudeArgs(req)).toThrowError(
      "claude session id must be a UUID: session-123-abc"
    );
  });

  it("accepts valid UUID session.id and appends --session-id", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const req: SpawnRequest = {
      ...baseReq,
      session: { id: uuid },
    };
    const args = buildClaudeArgs(req);
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(uuid);
    expect(args).not.toContain("--resume");
  });

  it("accepts valid UUID session.resume and appends --resume", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const req: SpawnRequest = {
      ...baseReq,
      session: { resume: uuid },
    };
    const args = buildClaudeArgs(req);
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(uuid);
    expect(args).not.toContain("--session-id");
  });

  it("appends --append-system-prompt when system_append is non-empty", () => {
    const req: SpawnRequest = {
      ...baseReq,
      system_append: "You are an expert engineer.",
    };
    const args = buildClaudeArgs(req);
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      "You are an expert engineer."
    );
  });

  it("omits --append-system-prompt when system_append is empty or whitespace", () => {
    const reqEmpty: SpawnRequest = {
      ...baseReq,
      system_append: "",
    };
    expect(buildClaudeArgs(reqEmpty)).not.toContain("--append-system-prompt");

    const reqWhitespace: SpawnRequest = {
      ...baseReq,
      system_append: "   \n\t ",
    };
    expect(buildClaudeArgs(reqWhitespace)).not.toContain("--append-system-prompt");
  });

  it("converts git <verb> to Bash(git <verb>*) and subagents to Agent", () => {
    const req: SpawnRequest = {
      ...baseReq,
      permission: {
        allow: ["git status", "Read"],
        deny: ["git commit", "git push", "subagents", "Bash(rm -rf*)"],
      },
    };
    const args = buildClaudeArgs(req);

    // Allow rules are not emitted: permissions are bypassed (owner decision 2026-10-19)
    expect(args).not.toContain("--allowedTools");

    // Disallowed tools
    expect(args).toContain("--disallowedTools");
    const disallowed = args[args.indexOf("--disallowedTools") + 1].split(",");
    expect(disallowed).toContain("Bash(git commit*)");
    expect(disallowed).toContain("Bash(git push*)");
    expect(disallowed).toContain("Agent");
    expect(disallowed).toContain("Bash(rm -rf*)");
  });

  it("launches with permissions bypassed and no permission-mode or allow list", () => {
    const req: SpawnRequest = {
      ...baseReq,
      permission: { allow: ["Bash", "Read"], deny: ["git push"] },
    };
    const args = buildClaudeArgs(req);

    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--permission-prompts");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");

    const disallowed = args[args.indexOf("--disallowedTools") + 1].split(",");
    expect(disallowed).toContain("Agent");
    expect(disallowed).toContain("Bash(git push*)");
  });

  it("always includes Agent in --disallowedTools even when deny list is empty", () => {
    const req: SpawnRequest = {
      ...baseReq,
      permission: { allow: [], deny: [] },
    };
    const args = buildClaudeArgs(req);
    expect(args).toContain("--disallowedTools");
    const disallowed = args[args.indexOf("--disallowedTools") + 1].split(",");
    expect(disallowed).toContain("Agent");
  });
});

describe("Claude Usage Normalization: modelUsage selection", () => {
  it("selects model key with largest outputTokens from modelUsage", () => {
    const usage = extractClaudeUsage(
      {
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 1700,
          output_tokens: 650,
        },
        modelUsage: {
          "claude-3-haiku": {
            inputTokens: 1000,
            outputTokens: 50,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0.001,
          },
          "claude-3-7-sonnet": {
            inputTokens: 500,
            outputTokens: 500,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0.04,
          },
          "claude-3-5-sonnet": {
            inputTokens: 200,
            outputTokens: 100,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0.009,
          },
        },
      },
      "claude-haiku-5-5"
    );

    expect(usage.model).toBe("claude-3-7-sonnet");
    expect(usage.output_tokens).toBe(650);
    expect(usage.cost_source).toBe("reported");
  });

  it("falls back to fallback model when modelUsage is absent or empty", () => {
    const usage = extractClaudeUsage(
      {
        total_cost_usd: 0.01,
        input_tokens: 100,
        output_tokens: 20,
      },
      "claude-haiku-fallback"
    );

    expect(usage.model).toBe("claude-haiku-fallback");
  });
});
