import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { EnvReport, HarnessAdapter, ModelInfo, Settings } from "../contracts/index.js";
import { pricingTableFor, ratesFor } from "../backends/pricing.js";
import type { UsageLedgerEntry } from "../contracts/index.js";
import {
  distinctTasks,
  FIRST_GENERATION,
  ledgerPaths,
  readUsageLedger,
  taskGenerationKey,
} from "../ledger/usage.js";

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
  /** false: rebuild the entries without writing the cache file (request validation creates nothing). */
  writeCache?: boolean;
}

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function priceFor(settings: Settings, modelId: string): ModelEntry["price_per_mtok"] {
  const rates = ratesFor(modelId, pricingTableFor(settings).models);
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
  if (built && options.writeCache !== false) {
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

// ===== models --stats =====

export interface ModelStat {
  model: string;
  provider: string;
  tasks: number;
  first_pass_rate: number | null;
  heal_rate: number | null;
  replans: number;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  avg_cost_per_passed_task: number | null;
  cost_unknown: boolean;
  note?: "no data";
}

export interface ModelStatsOptions {
  projectRoot: string;
  since?: number;
}

// The fields of a run's events.jsonl line that the stats read. Each one is
// present only when the line carries it with the right type.
interface StatEvent {
  type: string;
  ts: number;
  task_id?: string;
  generation?: number;
  attempt?: number;
  passed?: boolean;
  model?: string;
  backend?: string;
}

interface Attribution {
  provider: string;
  model: string;
}

interface GenerationFacts {
  first_pass: boolean;
  healed: boolean;
  passed: boolean;
}

interface Accumulator {
  provider: string;
  model: string;
  tasks: number;
  first_pass: number;
  healed: number;
  replans: number;
  ledger_rows: number;
  input_tokens: number;
  output_tokens: number;
  passed_with_ledger: number;
  passed_cost: number;
  cost_unknown: boolean;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

// Reads one events.jsonl line by line. A missing or unreadable file gives [];
// a line that is not JSON or lacks a string type and a parsable ts is skipped.
function readRunEvents(file: string): StatEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: StatEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn or malformed line: skipped
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== "string" || typeof obj.ts !== "string") continue;
    const ts = Date.parse(obj.ts);
    if (Number.isNaN(ts)) continue;
    const data =
      typeof obj.data === "object" && obj.data !== null ? (obj.data as Record<string, unknown>) : {};
    const record =
      typeof data.record === "object" && data.record !== null ? (data.record as Record<string, unknown>) : {};
    events.push({
      type: obj.type,
      ts,
      task_id: typeof data.task_id === "string" ? data.task_id : undefined,
      generation: optionalInt(data.generation),
      attempt: optionalInt(data.attempt),
      passed: typeof data.passed === "boolean" ? data.passed : undefined,
      model: typeof record.model === "string" && record.model.length > 0 ? record.model : undefined,
      backend: typeof record.backend === "string" ? record.backend : undefined,
    });
  }
  return events;
}

// task.passed may omit its generation. It is then the highest generation of that
// task seen so far in the same run's events (FIRST_GENERATION if none was seen).
function resolvePassedGenerations(events: StatEvent[]): void {
  const highest = new Map<string, number>();
  for (const event of events) {
    if (event.task_id === undefined) continue;
    if (event.type === "task.passed" && event.generation === undefined) {
      event.generation = highest.get(event.task_id) ?? FIRST_GENERATION;
    }
    if (event.generation !== undefined) {
      const seen = highest.get(event.task_id);
      if (seen === undefined || event.generation > seen) {
        highest.set(event.task_id, event.generation);
      }
    }
  }
}

// Every run directory under <projectRoot>/.substrate/runs, keyed by run id.
function readRuns(projectRoot: string): Map<string, StatEvent[]> {
  const runs = new Map<string, StatEvent[]>();
  const runsDir = path.join(projectRoot, ".substrate", "runs");
  let names: string[];
  try {
    names = fs.readdirSync(runsDir).sort();
  } catch {
    return runs;
  }
  for (const runId of names) {
    const events = readRunEvents(path.join(runsDir, runId, "events.jsonl"));
    resolvePassedGenerations(events);
    runs.set(runId, events);
  }
  return runs;
}

// The model of each task generation: the first ledger row with a model, else the
// first usage.recorded event of that generation (used when the ledger lacks it).
function attributeGenerations(
  ledger: UsageLedgerEntry[],
  runs: Map<string, StatEvent[]>,
): Map<string, Attribution> {
  const attributed = new Map<string, Attribution>();
  for (const [key, rows] of distinctTasks(ledger)) {
    const first = rows.find((row) => row.model.length > 0);
    if (first) {
      attributed.set(key, { provider: first.backend, model: first.model });
    }
  }
  for (const [runId, events] of runs) {
    for (const event of events) {
      if (event.type !== "usage.recorded") continue;
      if (event.task_id === undefined || event.generation === undefined) continue;
      if (event.model === undefined || event.backend === undefined) continue;
      const key = taskGenerationKey(runId, event.task_id, event.generation);
      if (!attributed.has(key)) {
        attributed.set(key, { provider: event.backend, model: event.model });
      }
    }
  }
  return attributed;
}

function generationFacts(runs: Map<string, StatEvent[]>): Map<string, GenerationFacts> {
  const facts = new Map<string, GenerationFacts>();
  for (const [runId, events] of runs) {
    for (const event of events) {
      if (event.task_id === undefined || event.generation === undefined) continue;
      const key = taskGenerationKey(runId, event.task_id, event.generation);
      let entry = facts.get(key);
      if (!entry) {
        entry = { first_pass: false, healed: false, passed: false };
        facts.set(key, entry);
      }
      if (event.type === "task.verify.finished" && event.attempt === 1 && event.passed === true) {
        entry.first_pass = true;
      }
      if (event.type === "task.healing") entry.healed = true;
      if (event.type === "task.passed") entry.passed = true;
    }
  }
  return facts;
}

/**
 * Per-model insights from the project ledger and every run's events.jsonl. The
 * `since` cutoff (epoch ms) filters ledger rows and events by timestamp. A replan
 * is credited to the model of the generation before it (task.replanned carries the
 * new generation), using the unfiltered data so a replan is never orphaned by the
 * window. Missing values are null; nothing is estimated.
 */
export function modelStats(opts: ModelStatsOptions): ModelStat[] {
  const since = opts.since;
  const inWindow = (ts: number): boolean => since === undefined || ts >= since;

  const ledgerFile = ledgerPaths({ projectRoot: opts.projectRoot, globalEnabled: false, env: process.env }).project;
  const ledgerAll = readUsageLedger(ledgerFile);
  const runsAll = readRuns(opts.projectRoot);

  const ledgerIn = ledgerAll.filter((entry) => inWindow(Date.parse(entry.ts)));
  const runsIn = new Map<string, StatEvent[]>();
  for (const [runId, events] of runsAll) {
    runsIn.set(runId, events.filter((event) => inWindow(event.ts)));
  }

  const attributedAll = attributeGenerations(ledgerAll, runsAll);
  const attributedIn = attributeGenerations(ledgerIn, runsIn);
  const ledgerByKey = distinctTasks(ledgerIn);
  const factsByKey = generationFacts(runsIn);

  const accumulators = new Map<string, Accumulator>();
  const accumulatorFor = (attribution: Attribution): Accumulator => {
    const id = JSON.stringify([attribution.provider, attribution.model]);
    let acc = accumulators.get(id);
    if (!acc) {
      acc = {
        provider: attribution.provider,
        model: attribution.model,
        tasks: 0,
        first_pass: 0,
        healed: 0,
        replans: 0,
        ledger_rows: 0,
        input_tokens: 0,
        output_tokens: 0,
        passed_with_ledger: 0,
        passed_cost: 0,
        cost_unknown: false,
      };
      accumulators.set(id, acc);
    }
    return acc;
  };

  // Every model seen in the window gets a row, so a model with rows but no task
  // generation (for example planner rows only) is listed with note "no data".
  for (const row of ledgerIn) {
    if (row.model.length > 0) accumulatorFor({ provider: row.backend, model: row.model });
  }
  for (const events of runsIn.values()) {
    for (const event of events) {
      if (event.type === "usage.recorded" && event.model !== undefined && event.backend !== undefined) {
        accumulatorFor({ provider: event.backend, model: event.model });
      }
    }
  }

  for (const [key, attribution] of attributedIn) {
    const acc = accumulatorFor(attribution);
    acc.tasks += 1;
    const facts = factsByKey.get(key);
    if (facts?.first_pass) acc.first_pass += 1;
    if (facts?.healed) acc.healed += 1;

    const rows = ledgerByKey.get(key) ?? [];
    for (const row of rows) {
      acc.ledger_rows += 1;
      acc.input_tokens += row.input_tokens;
      acc.output_tokens += row.output_tokens;
    }
    if (facts?.passed && rows.length > 0) {
      acc.passed_with_ledger += 1;
      for (const row of rows) {
        acc.passed_cost += row.cost_usd;
        if (row.cost_source === "unknown") acc.cost_unknown = true;
      }
    }
  }

  for (const [runId, events] of runsIn) {
    for (const event of events) {
      if (event.type !== "task.replanned") continue;
      if (event.task_id === undefined || event.generation === undefined) continue;
      const previous = event.generation - 1;
      if (previous < FIRST_GENERATION) continue;
      const attribution = attributedAll.get(taskGenerationKey(runId, event.task_id, previous));
      if (!attribution) continue;
      accumulatorFor(attribution).replans += 1;
    }
  }

  const stats: ModelStat[] = [...accumulators.values()].map((acc) => {
    const tasks = acc.tasks;
    const stat: ModelStat = {
      model: acc.model,
      provider: acc.provider,
      tasks,
      first_pass_rate: tasks > 0 ? acc.first_pass / tasks : null,
      heal_rate: tasks > 0 ? acc.healed / tasks : null,
      replans: acc.replans,
      avg_input_tokens: tasks > 0 && acc.ledger_rows > 0 ? acc.input_tokens / tasks : null,
      avg_output_tokens: tasks > 0 && acc.ledger_rows > 0 ? acc.output_tokens / tasks : null,
      avg_cost_per_passed_task:
        acc.passed_with_ledger > 0 ? acc.passed_cost / acc.passed_with_ledger : null,
      cost_unknown: acc.cost_unknown,
    };
    if (tasks === 0) stat.note = "no data";
    return stat;
  });

  return stats.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}
