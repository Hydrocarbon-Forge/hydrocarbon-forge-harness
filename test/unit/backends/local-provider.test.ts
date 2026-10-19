import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

import { Settings } from "../../../src/contracts/index.js";
import { loadSettings } from "../../../src/config/index.js";
import {
  OpenCodeAdapter,
  generateOpenCodeRunConfigSync,
} from "../../../src/backends/adapters/opencode.js";
import type { SpawnRequest } from "../../../src/contracts/index.js";

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

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sub-local-prov-"));
}

describe("R4.3 local provider config and adapter", () => {
  describe("rejection outside settings.local.json", () => {
    it("rejects backends.opencode.provider in settings.json", async () => {
      const port = await getFreePort();
      const dir = tmpDir();
      try {
        const subDir = join(dir, ".substrate");
        mkdirSync(subDir, { recursive: true });
        writeFileSync(
          join(subDir, "settings.json"),
          JSON.stringify({
            backends: {
              opencode: {
                provider: {
                  id: "local",
                  npm: "@ai-sdk/openai-compatible",
                  base_url: `http://localhost:${port}/v1`,
                  models: { "llama-local": {} },
                },
              },
            },
          }),
          "utf8"
        );

        await expect(loadSettings({ projectDir: dir, userConfigDir: dir, env: {} })).rejects.toThrow(
          "backends.opencode.provider may only be set in .substrate/settings.local.json"
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects backends.opencode.provider in user settings", async () => {
      const port = await getFreePort();
      const projectDir = tmpDir();
      const userDir = tmpDir();
      try {
        mkdirSync(userDir, { recursive: true });
        writeFileSync(
          join(userDir, "settings.json"),
          JSON.stringify({
            backends: {
              opencode: {
                provider: {
                  id: "local",
                  npm: "@ai-sdk/openai-compatible",
                  base_url: `http://localhost:${port}/v1`,
                  models: { "llama-local": {} },
                },
              },
            },
          }),
          "utf8"
        );

        await expect(
          loadSettings({ projectDir, userConfigDir: userDir, env: {} })
        ).rejects.toThrow(
          "backends.opencode.provider may only be set in .substrate/settings.local.json"
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(userDir, { recursive: true, force: true });
      }
    });

    it("accepts backends.opencode.provider when set in settings.local.json", async () => {
      const port = await getFreePort();
      const dir = tmpDir();
      try {
        const subDir = join(dir, ".substrate");
        mkdirSync(subDir, { recursive: true });
        writeFileSync(
          join(subDir, "settings.local.json"),
          JSON.stringify({
            backends: {
              opencode: {
                provider: {
                  id: "local",
                  npm: "@ai-sdk/openai-compatible",
                  base_url: `http://localhost:${port}/v1`,
                  models: { "llama-local": { name: "Llama Local" } },
                },
              },
            },
          }),
          "utf8"
        );

        const loaded = await loadSettings({ projectDir: dir, userConfigDir: dir, env: {} });
        const provider = loaded.backends?.["opencode"]?.provider;
        expect(provider).toBeDefined();
        expect(provider?.id).toBe("local");
        expect(provider?.npm).toBe("@ai-sdk/openai-compatible");
        expect(provider?.base_url).toBe(`http://localhost:${port}/v1`);
        expect(provider?.models?.["llama-local"]?.name).toBe("Llama Local");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("scheme check", () => {
    const baseValidSettings = {
      roles: { planner: { backend: "claude" as const, model: "m" } },
      routing: { feature: { backend: "claude" as const, model: "m" } },
      pricing: { asOf: "2026-10-16", sources: ["https://example.com"], models: {} },
      budgets: {
        run: {},
        task: {},
        l1_replans_per_task: 2,
        l2_per_run: 2,
        planner_format_retries: 2,
        approval_threshold_usd: 2,
      },
      concurrency: { workers: 3 },
      permissions: { allow: [], deny: [] },
      sandbox: { enabled: false, network: "deny" as const },
      git: { on_scope_violation: "revert" as const, branch_prefix: "substrate/", auto_merge: false },
      instructions: { workers: "none" as const },
      execution: { strategy: "direct" as const },
    };

    it("accepts http and https schemes", async () => {
      const port = await getFreePort();
      const validHttp = Settings.safeParse({
        ...baseValidSettings,
        backends: {
          opencode: {
            provider: {
              id: "local",
              npm: "@ai-sdk/openai-compatible",
              base_url: `http://localhost:${port}/v1`,
              models: {},
            },
          },
        },
      });
      expect(validHttp.success).toBe(true);

      const validHttps = Settings.safeParse({
        ...baseValidSettings,
        backends: {
          opencode: {
            provider: {
              id: "local",
              npm: "@ai-sdk/openai-compatible",
              base_url: `https://localhost:${port}/v1`,
              models: {},
            },
          },
        },
      });
      expect(validHttps.success).toBe(true);
    });

    it("rejects non-http/https schemes such as ftp or non-url strings", () => {
      const rejectFtp = Settings.safeParse({
        ...baseValidSettings,
        backends: {
          opencode: {
            provider: {
              id: "local",
              npm: "@ai-sdk/openai-compatible",
              base_url: "ftp://example.com/v1",
              models: {},
            },
          },
        },
      });
      expect(rejectFtp.success).toBe(false);

      const rejectNonUrl = Settings.safeParse({
        ...baseValidSettings,
        backends: {
          opencode: {
            provider: {
              id: "local",
              npm: "@ai-sdk/openai-compatible",
              base_url: "not-a-valid-url",
              models: {},
            },
          },
        },
      });
      expect(rejectNonUrl.success).toBe(false);
    });
  });

  describe("generated provider block", () => {
    it("writes provider block into per-run config opencode.json and cleans up", async () => {
      const port = await getFreePort();
      const cwd = tmpDir();
      try {
        const req: SpawnRequest = {
          role: "worker",
          cwd,
          prompt: "test prompt",
          model: "local-model",
          permission: { allow: [], deny: [] },
          budget: { timeout_ms: 30000 },
        };

        const baseUrl = `http://localhost:${port}/v1`;
        const config = generateOpenCodeRunConfigSync(req, {
          provider: {
            id: "local",
            npm: "@ai-sdk/openai-compatible",
            base_url: baseUrl,
            models: {
              "local-model": { name: "Local Llama" },
            },
          },
        });

        const configPath = join(cwd, "opencode.json");
        expect(existsSync(configPath)).toBe(true);

        const parsed = JSON.parse(readFileSync(configPath, "utf8"));
        expect(parsed.provider).toBeDefined();
        expect(parsed.provider.local).toEqual({
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: baseUrl,
            apiKey: "",
          },
          models: {
            "local-model": { name: "Local Llama" },
          },
        });

        await config.cleanup();
        expect(existsSync(configPath)).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe("model string mapping", () => {
    it("maps model name matching provider.models key to <id>/<key>", async () => {
      const port = await getFreePort();
      const baseUrl = `http://localhost:${port}/v1`;
      const provider = {
        id: "local",
        npm: "@ai-sdk/openai-compatible" as const,
        base_url: baseUrl,
        models: {
          "llama3": {},
        },
      };

      const adapter = new OpenCodeAdapter({
        binPath: "opencode",
        provider,
      });

      expect(adapter.mapModel("llama3")).toBe("local/llama3");
      expect(adapter.mapModel("llama3", "high")).toBe("local/llama3#high");
      expect(adapter.mapModel("local/llama3")).toBe("local/llama3");
      expect(adapter.mapModel("other-model")).toBe("other-model");

      const customProviderAdapter = new OpenCodeAdapter({
        binPath: "opencode",
        provider: {
          ...provider,
          id: "custom-local",
        },
      });
      expect(customProviderAdapter.mapModel("llama3")).toBe("custom-local/llama3");
    });
  });

  describe("capabilities and concurrency", () => {
    it("exposes max_concurrency 2 by default when provider is set", async () => {
      const port = await getFreePort();
      const baseUrl = `http://localhost:${port}/v1`;
      const adapter = new OpenCodeAdapter({
        binPath: "opencode",
        provider: {
          id: "local",
          npm: "@ai-sdk/openai-compatible",
          base_url: baseUrl,
          models: {},
        },
      });
      expect(adapter.capabilities.max_concurrency).toBe(2);
    });

    it("respects explicit backends.opencode.max_concurrency", async () => {
      const port = await getFreePort();
      const baseUrl = `http://localhost:${port}/v1`;
      const adapter = new OpenCodeAdapter({
        binPath: "opencode",
        maxConcurrency: 4,
        provider: {
          id: "local",
          npm: "@ai-sdk/openai-compatible",
          base_url: baseUrl,
          models: {},
        },
      });
      expect(adapter.capabilities.max_concurrency).toBe(4);
    });
  });
});
