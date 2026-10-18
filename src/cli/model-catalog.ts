import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { EnvReport, HarnessAdapter, ModelInfo, Settings } from "../contracts/index.js";
import { pricingTableFor } from "../backends/pricing.js";

const PROVIDERS = ["claude", "opencode", "agy"] as const;
const PROVIDER_ORDER: string[] = [...PROVIDERS]; // parsed entries compare against the canonical order

export const ModelEntry = z.object({
  id: z.string(),
  provider: z.string(),
  display: z.string().optional(),
  efforts: z.array(z.string()),
  source: z.enum(["cli", "static", "settings"]),
  price_per_mtok: z
    .object({
      input: z.number(),
      output: z.number(),
    })
    .strict()
    .nullable(),
  slots: z.array(z.string()),
}).strict();
export type ModelEntry = z.infer<typeof ModelEntry>;

export const ProviderEntry = z.object({
  provider: z.enum(PROVIDERS),
  installed: z.boolean(),
  version: z.string().optional(),
  version_pin: z.string().optional(),
  pin_matches: z.boolean(),
  problems: z.array(z.string()),
  models: z.array(ModelEntry),
}).strict();
export type ProviderEntry = z.infer<typeof ProviderEntry>;

export const ModelCatalog = z.object({
  v: z.literal(1),
  generated_at: z.string(),
  cache: z.enum(["fresh", "cached"]),
  providers: z.array(ProviderEntry),
  all_models: z.array(ModelEntry),
}).strict();
export type ModelCatalog = z.infer<typeof ModelCatalog>;

// The cache file stores provider entries only; `cache` and `all_models` are computed at read time.
const CacheFile = z.object({
  v: z.literal(1),
  generated_at: z.string(),
  providers: z.array(ProviderEntry),
}).strict();

export interface BuildCatalogOptions {
  settings: Settings;
  adapters: Record<string, HarnessAdapter>;
  refresh: boolean;
  cacheFile: string;
  now?: Date;
}

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function priceFor(settings: Settings, modelId: string): ModelEntry["price_per_mtok"] {
  const rates = pricingTableFor(settings).models[modelId];
  if (!rates) return null;
  return { input: rates.input_per_mtok, output: rates.output_per_mtok };
}

function slotsFor(settings: Settings, modelId: string): string[] {
  const slots: string[] = [];
  if (settings.roles?.planner?.model === modelId) slots.push("roles.planner");
  if (settings.roles?.worker?.model === modelId) slots.push("roles.worker");
  for (const [cls, route] of Object.entries(settings.routing ?? {})) {
    if (Array.isArray(route)) continue; // escalation chains are lists of aliases, not routes
    if (route.model === modelId) slots.push(`routing.${cls}`);
  }
  return slots;
}

function modelEntry(info: ModelInfo, provider: string, settings: Settings): ModelEntry {
  return ModelEntry.parse({
    id: info.id,
    provider,
    display: info.display,
    efforts: [...info.efforts],
    source: info.source,
    price_per_mtok: priceFor(settings, info.id),
    slots: slotsFor(settings, info.id),
  });
}

async function buildProviderEntry(
  name: string,
  adapter: HarnessAdapter,
  settings: Settings
): Promise<ProviderEntry> {
  let report: EnvReport;
  try {
    report = await adapter.validateEnvironment();
  } catch (err) {
    return ProviderEntry.parse({
      provider: name,
      installed: false,
      version_pin: adapter.capabilities.version_pin,
      pin_matches: false,
      problems: [(err as Error).message],
      models: [],
    });
  }

  let infos: ModelInfo[] = [];
  if (adapter.listModels) {
    try {
      infos = await adapter.listModels();
    } catch (err) {
      return ProviderEntry.parse({
        provider: name,
        installed: false,
        version: report.version,
        version_pin: adapter.capabilities.version_pin,
        pin_matches: report.pin_matches,
        problems: [...report.problems, (err as Error).message],
        models: [],
      });
    }
  }

  return ProviderEntry.parse({
    provider: name,
    installed: report.ok,
    version: report.version,
    version_pin: adapter.capabilities.version_pin,
    pin_matches: report.pin_matches,
    problems: [...report.problems],
    models: infos.map((info) => modelEntry(info, name, settings)),
  });
}

function readCacheFile(cacheFile: string): z.infer<typeof CacheFile> | null {
  let text: string;
  try {
    text = fs.readFileSync(cacheFile, "utf8");
  } catch {
    return null;
  }
  try {
    return CacheFile.parse(JSON.parse(text));
  } catch {
    return null; // corrupt cache is ignored; it will be rewritten from the rebuild below
  }
}

function writeCacheFile(cacheFile: string, providers: ProviderEntry[], generatedAt: string): void {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, generated_at: generatedAt, providers }, null, 2), "utf8");
}

export async function buildCatalog(options: BuildCatalogOptions): Promise<ModelCatalog> {
  const settings = options.settings;
  const now = options.now ?? new Date();
  const cache = readCacheFile(options.cacheFile);
  const cacheUsable =
    !options.refresh && cache !== null && now.getTime() - Date.parse(cache.generated_at) < CACHE_MAX_AGE_MS;

  const entries: ProviderEntry[] = [];
  let built = false;
  for (const name of PROVIDERS) {
    const adapter = options.adapters[name];
    if (!adapter) continue;
    const cached = cache?.providers.find((p) => p.provider === name);
    if (cacheUsable && cached) {
      entries.push(cached);
      continue;
    }
    entries.push(await buildProviderEntry(name, adapter, settings));
    built = true;
  }

  const generatedAt = cacheUsable && !built ? cache!.generated_at : now.toISOString();
  if (built) {
    // Entries for providers outside this run's scope are preserved from the cache file.
    const preserved = (cache?.providers ?? []).filter((p) => !entries.some((e) => e.provider === p.provider));
    const merged = [...entries, ...preserved].sort(
      (a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider),
    );
    writeCacheFile(options.cacheFile, merged, generatedAt);
  }

  const allModels = entries
    .flatMap((p) => p.models)
    .sort(
      (a, b) =>
        PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) ||
        a.id.localeCompare(b.id),
    );

  return ModelCatalog.parse({
    v: 1,
    generated_at: generatedAt,
    cache: built ? "fresh" : "cached",
    providers: entries,
    all_models: allModels,
  });
}
