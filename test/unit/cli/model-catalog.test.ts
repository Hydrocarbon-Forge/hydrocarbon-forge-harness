import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { EnvReport, HarnessAdapter, ModelInfo, Settings } from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { buildCatalog } from "../../../src/cli/model-catalog.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface FakeAdapter extends HarnessAdapter {
  validateCalls: number;
  listModelsCalls: number;
}

function fakeAdapter(
  name: "claude" | "opencode" | "agy",
  behavior: {
    report?: EnvReport;
    models?: ModelInfo[];
    throwValidate?: string;
    throwModels?: string;
  } = {},
): FakeAdapter {
  const adapter: FakeAdapter = {
    capabilities: {
      name,
      version_pin: "0.0.0",
      effort: true,
      structured_output: false,
      cost_reported: false,
      resume: false,
      permission_denial_signal: "none",
      sandbox_flag: false,
      native_subagents_headless: false,
    },
    validateCalls: 0,
    listModelsCalls: 0,
    validateEnvironment(): Promise<EnvReport> {
      adapter.validateCalls += 1;
      if (behavior.throwValidate) return Promise.reject(new Error(behavior.throwValidate));
      return Promise.resolve(
        behavior.report ?? { ok: true, version: "1.0.0", pin_matches: true, problems: [] },
      );
    },
    spawn(): never {
      throw new Error("the catalog builder must not spawn sessions");
    },
    listModels(): Promise<ModelInfo[]> {
      adapter.listModelsCalls += 1;
      if (behavior.throwModels) return Promise.reject(new Error(behavior.throwModels));
      return Promise.resolve(behavior.models ?? []);
    },
  };
  return adapter;
}

function entry(id: string, efforts: string[], source: "cli" | "static" | "settings", display?: string): ModelInfo {
  return { id, efforts, source, display };
}

// Settings with slots for unit-haiku (planner + worker + routing.feature; the
// escalation array must not count as a slot) and one priced model only.
const TEST_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  roles: {
    planner: { backend: "claude", model: "unit-haiku", effort: "low" },
    worker: { backend: "agy", model: "unit-haiku", effort: "medium" },
  },
  routing: {
    feature: { backend: "claude", model: "unit-haiku", effort: "high" },
    escalation: ["unit-haiku"],
  },
  pricing: {
    asOf: DEFAULT_SETTINGS.pricing.asOf,
    sources: DEFAULT_SETTINGS.pricing.sources,
    models: {
      "unit-haiku": { input_per_mtok: 1, output_per_mtok: 5 },
    },
  },
};

describe("model catalog", () => {
  let tmpDir: string;
  let cacheFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-model-catalog-"));
    cacheFile = join(tmpDir, ".substrate", "state", "models.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first build is fresh and writes the cache file with the v1 shape", async () => {
    const adapters = {
      claude: fakeAdapter("claude", { models: [entry("unit-haiku", ["low"], "settings")] }),
      opencode: fakeAdapter("opencode", { models: [entry("opencode-unit-model", [], "cli")] }),
      agy: fakeAdapter("agy", { models: [entry("agy-unit-model", ["high"], "cli")] }),
    };

    const now = new Date("2026-10-18T12:00:00.000Z");
    const catalog = await buildCatalog({
      settings: TEST_SETTINGS,
      adapters,
      refresh: false,
      cacheFile,
      now,
    });

    expect(catalog.cache).toBe("fresh");
    expect(catalog.generated_at).toBe("2026-10-18T12:00:00.000Z");

    // Providers appear in canonical order regardless of adapter key order.
    expect(catalog.providers.map((p) => p.provider)).toEqual(["claude", "opencode", "agy"]);

    const cacheData = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cacheData.v).toBe(1);
    expect(cacheData.generated_at).toBe("2026-10-18T12:00:00.000Z");
    expect(cacheData.providers.map((p: { provider: string }) => p.provider)).toEqual([
      "claude",
      "opencode",
      "agy",
    ]);

    // Guardrail: the only file the catalog writes is the cache file itself.
    expect(readdirSync(join(tmpDir, ".substrate", "state"))).toEqual(["models.json"]);
  });

  it("a second build within 24h is served from the cache without touching adapters", async () => {
    const adapters = {
      claude: fakeAdapter("claude", { models: [entry("unit-haiku", ["low"], "settings")] }),
    };

    const first = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    expect(first.cache).toBe("fresh");
    const callsAfterFirst = { validate: adapters.claude.validateCalls, listModels: adapters.claude.listModelsCalls };
    expect(callsAfterFirst.validate).toBe(1);

    const second = await buildCatalog({
      settings: TEST_SETTINGS,
      adapters,
      refresh: false,
      cacheFile,
      now: new Date(Date.parse(first.generated_at) + 60 * 60 * 1000),
    });

    expect(second.cache).toBe("cached");
    expect(second.generated_at).toBe(first.generated_at);
    expect(adapters.claude.validateCalls).toBe(callsAfterFirst.validate);
    expect(adapters.claude.listModelsCalls).toBe(callsAfterFirst.listModels);
    expect(JSON.stringify(second.providers)).toBe(JSON.stringify(first.providers));
  });

  it("a cache older than 24h is ignored and rebuilt", async () => {
    const adapters = {
      claude: fakeAdapter("claude", { report: { ok: true, version: "1.0.0", pin_matches: true, problems: [] } }),
    };

    const generatedAt = new Date("2026-10-17T12:00:00.000Z");
    const first = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile, now: generatedAt });
    expect(first.cache).toBe("fresh");

    const stale = await buildCatalog({
      settings: TEST_SETTINGS,
      adapters,
      refresh: false,
      cacheFile,
      now: new Date(Date.parse(first.generated_at) + DAY_MS + 1000),
    });

    expect(stale.cache).toBe("fresh");
    expect(adapters.claude.validateCalls).toBe(2);
    const cacheData = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cacheData.generated_at).not.toBe(first.generated_at);
  });

  it("--refresh ignores a fresh cache and rebuilds", async () => {
    const adapters = { claude: fakeAdapter("claude") };

    const first = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    expect(first.cache).toBe("fresh");

    const refreshed = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: true, cacheFile });
    expect(refreshed.cache).toBe("fresh");
    expect(adapters.claude.validateCalls).toBe(2);
  });

  it("a corrupt cache file is ignored and rewritten", async () => {
    mkdirSync(join(tmpDir, ".substrate", "state"), { recursive: true });
    writeFileSync(join(tmpDir, ".substrate", "state", "models.json"), "{ not json at all", "utf8");

    const adapters = {
      claude: fakeAdapter("claude", { models: [entry("unit-haiku", ["low"], "settings")] }),
    };

    const catalog = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    expect(catalog.cache).toBe("fresh");

    const cacheData = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cacheData.v).toBe(1);
    expect(cacheData.providers.map((p: { provider: string }) => p.provider)).toEqual(["claude"]);
  });

  it("prices models from the pricing table and leaves unpriced models null", async () => {
    const adapters = {
      claude: fakeAdapter("claude", {
        models: [entry("unit-haiku", ["low"], "settings"), entry("unit-unpriced", ["high"], "static")],
      }),
    };

    const catalog = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    const models = catalog.providers[0].models;

    const priced = models.find((m) => m.id === "unit-haiku");
    expect(priced?.price_per_mtok).toEqual({ input: 1, output: 5 });
    expect(models.find((m) => m.id === "unit-unpriced")?.price_per_mtok).toBeNull();
  });

  it("prices an effort variant at its base's rates and leaves a variant with an unpriced base null", async () => {
    const adapters = {
      claude: fakeAdapter("claude", {
        models: [
          entry("unit-haiku-high", ["high"], "cli"),
          entry("gpt-oss-120b-medium", ["medium"], "cli"),
        ],
      }),
    };

    const catalog = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    const models = catalog.providers[0].models;

    expect(models.find((m) => m.id === "unit-haiku-high")?.price_per_mtok).toEqual({ input: 1, output: 5 });
    expect(models.find((m) => m.id === "gpt-oss-120b-medium")?.price_per_mtok).toBeNull();
  });

  it("reports slots from roles and routing classes, skipping array entries", async () => {
    const adapters = {
      claude: fakeAdapter("claude", { models: [entry("unit-haiku", ["low"], "settings")] }),
      agy: fakeAdapter("agy", { models: [entry("agy-orphan", [], "cli")] }),
    };

    const catalog = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });

    // planner, worker, then routing.feature; routing.escalation is an array and must not count.
    const claudeEntry = catalog.providers.find((p) => p.provider === "claude");
    const agyEntry = catalog.providers.find((p) => p.provider === "agy");
    expect(catalog.providers.map((p) => p.provider)).toEqual(["claude", "agy"]);
    expect(claudeEntry?.models[0]?.slots).toEqual(["roles.planner", "roles.worker", "routing.feature"]);
    expect(agyEntry?.models[0]?.slots).toEqual([]);
  });

  it("a provider whose validateEnvironment throws reports installed:false with the message in problems", async () => {
    const adapters = { claude: fakeAdapter("claude", { throwValidate: "claude binary not found" }) };

    const catalog = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    const provider = catalog.providers[0];

    expect(provider.installed).toBe(false);
    expect(provider.models).toEqual([]);
    expect(provider.problems).toEqual(["claude binary not found"]);
    expect(provider.pin_matches).toBe(false);
    expect(provider.version_pin).toBe("0.0.0");
  });

  it("a provider whose listModels throws reports installed:false and records the message", async () => {
    const adapters = {
      agy: fakeAdapter("agy", {
        report: { ok: true, version: "1.4.2", pin_matches: true, problems: ["agy warning"] },
        throwModels: "agy models failed: boom",
      }),
    };

    const catalog = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    expect(catalog.providers.map((p) => p.provider)).toEqual(["agy"]);
    const provider = catalog.providers[0];

    expect(provider.installed).toBe(false);
    expect(provider.models).toEqual([]);
    expect(provider.problems).toEqual(["agy warning", "agy models failed: boom"]);
    expect(provider.version).toBe("1.4.2");
  });

  it("all_models is sorted by provider then model id", async () => {
    const adapters = {
      claude: fakeAdapter("claude", { models: [entry("unit-zeta", [], "static"), entry("unit-alpha", [], "static")] }),
      opencode: fakeAdapter("opencode", { models: [entry("opencode-mid", [], "cli")] }),
      agy: fakeAdapter("agy", { models: [entry("agy-beta", [], "cli")] }),
    };

    const catalog = await buildCatalog({ settings: TEST_SETTINGS, adapters, refresh: false, cacheFile });
    expect(catalog.all_models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "claude/unit-alpha",
      "claude/unit-zeta",
      "opencode/opencode-mid",
      "agy/agy-beta",
    ]);
  });

  it("--refresh with a single provider preserves the cached entries of the others", async () => {
    const all = {
      claude: fakeAdapter("claude", { models: [entry("unit-haiku", ["low"], "settings")] }),
      opencode: fakeAdapter("opencode", { models: [entry("opencode-unit-model", [], "cli")] }),
      agy: fakeAdapter("agy", { models: [entry("agy-unit-model", [], "cli")] }),
    };

    await buildCatalog({ settings: TEST_SETTINGS, adapters: all, refresh: false, cacheFile });
    const cachedOpencode = JSON.parse(readFileSync(cacheFile, "utf8")).providers.find(
      (p: { provider: string }) => p.provider === "opencode",
    );

    const catalog = await buildCatalog({
      settings: TEST_SETTINGS,
      adapters: { claude: all.claude },
      refresh: true,
      cacheFile,
    });

    expect(catalog.cache).toBe("fresh");
    expect(catalog.providers.map((p) => p.provider)).toEqual(["claude"]);

    const cacheData = JSON.parse(readFileSync(cacheFile, "utf8"));
    const providers = cacheData.providers as Array<{ provider: string }>;
    expect(providers.map((p) => p.provider)).toEqual(["claude", "opencode", "agy"]);
    expect(JSON.stringify(providers.find((p) => p.provider === "opencode"))).toBe(JSON.stringify(cachedOpencode));
  });

  it("a provider subset served from cache does not rewrite the cache file", async () => {
    const all = {
      claude: fakeAdapter("claude", { models: [entry("unit-haiku", ["low"], "settings")] }),
      opencode: fakeAdapter("opencode", { models: [entry("opencode-unit-model", [], "cli")] }),
    };

    const first = await buildCatalog({ settings: TEST_SETTINGS, adapters: all, refresh: false, cacheFile });
    const callsBefore = { validate: all.opencode.validateCalls, listModels: all.opencode.listModelsCalls };

    const served = await buildCatalog({
      settings: TEST_SETTINGS,
      adapters: { opencode: all.opencode },
      refresh: false,
      cacheFile,
    });

    expect(served.cache).toBe("cached");
    expect(served.providers.map((p) => p.provider)).toEqual(["opencode"]);
    expect(all.opencode.validateCalls).toBe(callsBefore.validate);
    expect(all.opencode.listModelsCalls).toBe(callsBefore.listModels);

    const cacheData = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cacheData.generated_at).toBe(first.generated_at);
  });
});
