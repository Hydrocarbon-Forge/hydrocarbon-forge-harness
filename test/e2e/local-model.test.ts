import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { runSubstrate } from "./helpers/run-substrate.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

describe("E2E Local-Model Worker Route", () => {
  it("routes to local model through OpenCode with per-run provider config and no committed endpoint", async () => {
    const port = await getFreePort();
    const baseUrl = `http://localhost:${port}/v1`;

    const tmp = mkdtempSync(join(tmpdir(), "sub-e2e-local-"));
    const capturedConfig = join(tmp, "captured-opencode.json");
    const argvLog = join(tmp, "argv.log");

    const scenarioJson = join(tmp, "scenario.json");
    writeFileSync(
      scenarioJson,
      JSON.stringify({
        calls: [
          {
            reply: "DONE",
            exit_code: 0,
          },
        ],
      }),
      "utf8"
    );

    const binPath = resolve(__dirname, "../fixtures/fake-harness/bin/opencode");
    const wrapperPath = join(tmp, "opencode-wrapper.sh");
    const script = `#!/bin/sh
if [ -f opencode.json ]; then
  cp opencode.json '${capturedConfig}'
fi
echo "$@" >> '${argvLog}'
export FAKE_SCENARIO_FILE='${scenarioJson}'
exec '${binPath}' "$@"
`;
    writeFileSync(wrapperPath, script, { mode: 0o755 });

    const localModelName = "my-local-llama";

    const res = runSubstrate({
      args: ["run", "--mode", "solo", "execute local worker"],
      settings: {
        backends: {
          opencode: {
            bin: wrapperPath,
          },
        },
        profiles: {
          "local-profile": {
            plan: { model: "claude-sonnet-5-5" },
            work: { model: localModelName },
          },
        },
        defaults: {
          planner_provider: "local-profile",
          worker_provider: "local-profile",
        },
        roles: {
          worker: {
            backend: "opencode",
            model: localModelName,
          },
        },
      },
      beforeRun: (repo) => {
        const substrateDir = join(repo.dir, ".substrate");
        mkdirSync(substrateDir, { recursive: true });
        writeFileSync(
          join(substrateDir, "settings.local.json"),
          JSON.stringify(
            {
              backends: {
                opencode: {
                  provider: {
                    id: "local",
                    npm: "@ai-sdk/openai-compatible",
                    base_url: baseUrl,
                    models: {
                      [localModelName]: {
                        name: "Local Llama Model",
                      },
                    },
                  },
                },
              },
            },
            null,
            2
          ),
          "utf8"
        );
      },
    });

    try {
      expect(res.exitCode).toBe(0);

      // Verify fake opencode received config containing the provider block
      expect(existsSync(capturedConfig)).toBe(true);
      const configContent = readFileSync(capturedConfig, "utf8");
      const parsedConfig = JSON.parse(configContent);

      expect(parsedConfig.provider).toBeDefined();
      expect(parsedConfig.provider.local).toBeDefined();
      expect(parsedConfig.provider.local.npm).toBe("@ai-sdk/openai-compatible");
      expect(parsedConfig.provider.local.options?.baseURL).toBe(baseUrl);
      expect(parsedConfig.provider.local.models?.[localModelName]).toBeDefined();

      // Verify opencode argv mapped model string to local/<model>
      expect(existsSync(argvLog)).toBe(true);
      const logContent = readFileSync(argvLog, "utf8");
      expect(logContent).toContain(`local/${localModelName}`);

      // Verify that no URL or host:port literal was committed to git
      const grepRes = spawnSync(
        "git",
        ["grep", "-nE", "https?://|[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+:[0-9]+"],
        {
          cwd: res.repoDir,
          encoding: "utf8",
        }
      );
      const matches = grepRes.stdout ? grepRes.stdout.trim() : "";
      expect(matches).toBe("");
      expect(grepRes.status).not.toBe(0);
    } finally {
      res.cleanup();
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });
});
