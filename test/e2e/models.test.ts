import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSubstrate } from "./helpers/run-substrate.js";
import { ModelCatalog } from "../../src/cli/model-catalog.js";

const CACHE_FILE = ".substrate/state/models.json";

// Isolates the user settings layer so results are deterministic on any machine:
// an empty config dir, and empty strings neutralize any inherited overrides.
function isolatedEnv(): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), "substrate-models-config-"));
  return {
    SUBSTRATE_CONFIG_DIR: configDir,
    SUBSTRATE_SETTINGS: "",
    SUBSTRATE_PROJECT_DIR: "",
    SUBSTRATE_MODEL: "",
    SUBSTRATE_WORKER_MODEL: "",
    SUBSTRATE_OUTPUT_FORMAT: "",
    SUBSTRATE_EXECUTION: "",
    SUBSTRATE_SETTINGS_CONTENT: "",
    SUBSTRATE_PERMISSION_MODE: "",
  };
}

// A cache entry shape that CacheFile.parse accepts; the distinctive problems string
// proves the run served the catalog from the seeded file instead of rebuilding it.
function seededCache(sentinel: string): { generatedAt: string; json: string } {
  const generatedAt = new Date(Date.now() - 60000).toISOString();
  const json = JSON.stringify({
    v: 1,
    generated_at: generatedAt,
    providers: ["claude", "opencode", "agy"].map((provider) => ({
      provider,
      installed: true,
      pin_matches: true,
      problems: [sentinel],
      models: [],
    })),
  });
  return { generatedAt, json };
}

describe("E2E models command", () => {
  it("writes a fresh cache file and prints one parseable ModelCatalog object", () => {
    const env = isolatedEnv();
    try {
      const res = runSubstrate({ args: ["models", "--output-format", "json"], env });
      try {
        expect(res.exitCode).toBe(0);
        expect(res.stderr).toBe("");
        expect(res.stdout.trim().split("\n")).toHaveLength(1);

        const catalog = ModelCatalog.parse(JSON.parse(res.stdout));
        expect(catalog.v).toBe(1);
        expect(catalog.cache).toBe("fresh");
        expect(catalog.providers.map((p) => p.provider)).toEqual(["claude", "opencode", "agy"]);

        // No provider is hard-coded in the command: these come from the adapters.
        const claude = catalog.providers[0];
        expect(claude.installed).toBe(true);
        expect(claude.pin_matches).toBe(true);
        const staticModels = claude.models.filter((m) => m.source === "static");
        expect(staticModels.map((m) => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);

        expect(catalog.all_models.map((m) => `${m.provider}:${m.id}`).sort()).toEqual(
          [
            "agy:claude-opus-4-6-thinking",
            "agy:claude-sonnet-4-6",
            "agy:gemini-3.8-flash-high",
            "agy:gemini-3.8-flash-low",
            "agy:gemini-3.8-flash-medium",
            "agy:gpt-oss-120b-medium",
            "claude:claude-sonnet-5-5",
            "claude:fable",
            "claude:haiku",
            "claude:opus",
            "claude:sonnet",
            "opencode:opencode/deepseek-v4.1-flash-free",
          ].sort(),
        );

        const cachePath = join(res.repoDir, CACHE_FILE);
        expect(existsSync(cachePath)).toBe(true);
        const cacheData = JSON.parse(readFileSync(cachePath, "utf8"));
        expect(cacheData.v).toBe(1);
        expect(cacheData.generated_at).toBe(catalog.generated_at);
        expect(cacheData.providers.map((p: { provider: string }) => p.provider)).toEqual([
          "claude",
          "opencode",
          "agy",
        ]);
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });

  it("serves a run from a cache file younger than 24h without touching the harnesses", () => {
    const env = isolatedEnv();
    const seeded = seededCache("seeded-cache-sentinel");
    try {
      const res = runSubstrate({
        args: ["models", "--output-format", "json"],
        files: { [CACHE_FILE]: seeded.json },
        env,
      });
      try {
        expect(res.exitCode).toBe(0);

        const catalog = ModelCatalog.parse(JSON.parse(res.stdout));
        expect(catalog.cache).toBe("cached");
        expect(catalog.generated_at).toBe(seeded.generatedAt);
        for (const provider of catalog.providers) {
          expect(provider.problems).toEqual(["seeded-cache-sentinel"]);
          expect(provider.models).toEqual([]);
        }

        // A fully cached run must not rewrite the cache file.
        const cacheData = JSON.parse(readFileSync(join(res.repoDir, CACHE_FILE), "utf8"));
        expect(cacheData.generated_at).toBe(seeded.generatedAt);
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });

  it("--provider claude filters to the claude provider through the dispatcher", () => {
    const env = isolatedEnv();
    try {
      const res = runSubstrate({
        args: ["models", "--provider", "claude", "--output-format", "json"],
        env,
      });
      try {
        expect(res.exitCode).toBe(0);

        const catalog = ModelCatalog.parse(JSON.parse(res.stdout));
        expect(catalog.providers.map((p) => p.provider)).toEqual(["claude"]);
        expect(catalog.providers[0].models.map((m) => m.id)).toEqual([
          "haiku",
          "sonnet",
          "opus",
          "fable",
          "claude-sonnet-5-5",
        ]);

        // The filter applies to the cache write too: only the scoped provider is stored.
        const cacheData = JSON.parse(readFileSync(join(res.repoDir, CACHE_FILE), "utf8"));
        expect(cacheData.providers.map((p: { provider: string }) => p.provider)).toEqual(["claude"]);
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });

  it("--refresh rebuilds a fresh cache through the dispatcher", () => {
    const env = isolatedEnv();
    const seeded = seededCache("refresh-should-not-appear");
    try {
      const res = runSubstrate({
        args: ["models", "--refresh", "--output-format", "json"],
        files: { [CACHE_FILE]: seeded.json },
        env,
      });
      try {
        expect(res.exitCode).toBe(0);

        const catalog = ModelCatalog.parse(JSON.parse(res.stdout));
        expect(catalog.cache).toBe("fresh");
        expect(catalog.generated_at).not.toBe(seeded.generatedAt);
        for (const provider of catalog.providers) {
          expect(provider.problems).toEqual([]);
        }
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });

  it("unknown provider exits 2 with the error on stderr and an error object in JSON mode", () => {
    const env = isolatedEnv();
    try {
      const res = runSubstrate({
        args: ["models", "--provider", "foo", "--output-format", "json"],
        env,
      });
      try {
        expect(res.exitCode).toBe(2);
        expect(res.stderr).toBe("Error: unknown provider foo\n");
        expect(JSON.parse(res.stdout)).toEqual({ error: "unknown provider foo" });
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });
});
