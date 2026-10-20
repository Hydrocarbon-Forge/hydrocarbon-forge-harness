import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { buildClaudeArgs } from "../../src/backends/adapters/claude.js";
import type { SpawnRequest } from "../../src/contracts/index.js";

function isCommandAvailable(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const shouldRun =
  process.env.SUBSTRATE_LIVE === "1" && isCommandAvailable("claude");

describe("Claude Live Args Test", () => {
  it.skipIf(!shouldRun)(
    "runs claude with flags built by buildClaudeArgs and asserts exit 0 and session_id match",
    () => {
      const uuid = crypto.randomUUID();
      const req: SpawnRequest = {
        role: "worker",
        cwd: process.cwd(),
        prompt: "reply OK",
        model: "claude-haiku-5-5",
        system_append: "x",
        session: { id: uuid },
        permission: { allow: [], deny: ["git commit"] },
        budget: { max_usd: 0.01, timeout_ms: 15000 },
      };

      const args = buildClaudeArgs(req);
      // Permissions are bypassed; no allow list or permission-mode is emitted (owner decision 2026-10-19)
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--permission-mode");
      expect(args).not.toContain("--allowedTools");
      const output = execFileSync("claude", args, {
        encoding: "utf8",
        timeout: 15000,
      });

      // Assert output contains valid JSON lines echoing session_id equal to uuid
      const lines = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      let foundSessionId = false;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.session_id === uuid) {
            foundSessionId = true;
          }
        } catch {}
      }
      expect(foundSessionId).toBe(true);
    }
  );
});
