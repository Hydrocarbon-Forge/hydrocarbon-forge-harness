import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter } from "../../../src/backends/adapters/claude.js";

const FAKE_CLAUDE = resolve(fileURLToPath(import.meta.url), "../../../fixtures/fake-harness/bin/claude");

// R13.1: the claude adapter sends the prompt on stdin, so a long prompt never becomes an argument (E2BIG).
describe("claude adapter: the prompt travels on stdin", () => {
  it("the harness receives the prompt on stdin and it is not in its argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-stdin-"));
    try {
      const log = join(dir, "argv.jsonl");
      const adapter = new ClaudeAdapter({ bin: FAKE_CLAUDE });
      const handle = adapter.spawn({
        role: "worker",
        cwd: dir,
        model: "claude-haiku-5-5",
        prompt: "PROMPT-ON-STDIN",
        permission: { allow: [], deny: [] },
        budget: {},
        session: { id: randomUUID() },
        env: { FAKE_ARGV_LOG: log },
      });
      await handle.result();

      const record = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]) as { argv: string[]; prompt: string };
      expect(record.prompt).toBe("PROMPT-ON-STDIN");
      expect(record.argv).not.toContain("PROMPT-ON-STDIN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
