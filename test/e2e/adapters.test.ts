import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runSubstrate } from "./helpers/run-substrate.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

describe("E2E Adapter Selection", () => {
  it("passes model from settings to claude harness executable in solo mode", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sub-e2e-adapter-"));
    const scenarioJson = join(tmp, "scenario.json");
    writeFileSync(
      scenarioJson,
      JSON.stringify({
        calls: [
          {
            edits: { "a.txt": "created\n" },
            reply: "DONE",
            exit_code: 0,
          },
        ],
      }),
      "utf8"
    );

    const argvLog = join(tmp, "argv.log");
    const binPath = resolve(__dirname, "../fixtures/fake-harness/bin/claude");
    const wrapperPath = join(tmp, "claude-wrapper.sh");
    const script = `#!/bin/sh\nexport FAKE_SCENARIO_FILE='${scenarioJson}'\nexport FAKE_ARGV_LOG='${argvLog}'\nexec '${binPath}' "$@"\n`;
    writeFileSync(wrapperPath, script, { mode: 0o755 });

    const res = runSubstrate({
      args: ["run", "--mode", "solo", "touch a.txt"],
      settings: {
        backends: {
          claude: {
            bin: wrapperPath,
          },
        },
        roles: {
          worker: {
            backend: "claude",
            model: "claude-haiku-5-5",
          },
        },
      },
    });

    try {
      expect(existsSync(argvLog)).toBe(true);
      const logContent = readFileSync(argvLog, "utf8");
      const lines = logContent.split("\n").filter((l) => l.trim().length > 0);
      const logged = lines.map((l) => JSON.parse(l));

      const entry = logged.find((e: { argv: string[] }) => {
        const modelIdx = e.argv.indexOf("--model");
        return modelIdx !== -1 && e.argv[modelIdx + 1] === "claude-haiku-5-5";
      });
      expect(entry).toBeDefined();

      const argv = entry.argv;

      // 1. --session-id is a UUID
      const sessionIdx = argv.indexOf("--session-id");
      expect(sessionIdx).not.toBe(-1);
      const sessionId = argv[sessionIdx + 1];
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(sessionId)).toBe(true);

      // 2. --append-system-prompt is present with the system text
      const appendIdx = argv.indexOf("--append-system-prompt");
      expect(appendIdx).not.toBe(-1);
      const systemPrompt = argv[appendIdx + 1];
      expect(systemPrompt.length).toBeGreaterThan(0);

      // 3. --disallowedTools contains Bash(git commit*) and Agent
      const disallowedIdx = argv.indexOf("--disallowedTools");
      expect(disallowedIdx).not.toBe(-1);
      const disallowed = argv[disallowedIdx + 1].split(",");
      expect(disallowed).toContain("Bash(git commit*)");
      expect(disallowed).toContain("Agent");

      const sessionStarted = res.events.find(
        (e) => e.type === "task.session.started"
      );
      expect(sessionStarted).toBeDefined();
    } finally {
      res.cleanup();
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });
});
