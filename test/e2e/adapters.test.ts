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

      const hasModelFlag = logged.some((entry: { argv: string[] }) => {
        const modelIdx = entry.argv.indexOf("--model");
        return modelIdx !== -1 && entry.argv[modelIdx + 1] === "claude-haiku-5-5";
      });
      expect(hasModelFlag).toBe(true);

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
