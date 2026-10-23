import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BackendName,
  ModelInfo,
  PricingTable,
  Settings,
} from "../../src/contracts/index.js";
import { loadSettings } from "../../src/config/index.js";
import { deepMerge } from "../../src/util/merge.js";
import { DEFAULT_PRICING } from "../../src/backends/default-pricing.js";
import { ratesFor } from "../../src/backends/pricing.js";
import { runSubstrate, type RunSubstrateResult } from "../e2e/helpers/run-substrate.js";
import { createE2ERepo, type E2ERepo } from "../e2e/helpers/repo.js";

export const LIVE_HARNESSES = ["claude", "opencode", "agy"] as const satisfies readonly BackendName[];
export type LiveHarness = (typeof LIVE_HARNESSES)[number];

/** Spend cap for one harness run (budgets.run.max_usd). */
export const RUN_CAP_USD = 0.25;
/** Spend cap for one task (budgets.task.max_usd). */
export const TASK_CAP_USD = 0.1;

/** The one-sentence toy task. Test data, not prompt engineering. */
export const TOY_TASK = "add a function `sum(a, b)` in `src/math.js` and a test for it";

/** Bare binary names: the live run resolves the real harnesses on PATH. */
const BIN_OVERLAY: Partial<Settings> = {
  backends: {
    claude: { bin: "claude" },
    opencode: { bin: "opencode" },
    agy: { bin: "agy" },
  },
};

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface LiveRecord {
  harness: LiveHarness;
  version: string;
  model: string;
  run_id: string;
  status: "passed" | "failed" | "skipped";
  exit_code: number | null;
  cost_usd: number;
  ts: string;
}

/**
 * Creates the toy repository the live run works on: a git repo with package.json
 * and src/math.js, committed as "seed". The caller owns cleanup().
 */
export function createToyRepo(): E2ERepo {
  return createE2ERepo({
    "package.json": JSON.stringify(
      { name: "toy-math", version: "0.0.0", private: true, scripts: { test: "node --test" } },
      null,
      2,
    ) + "\n",
    "src/math.js": "module.exports = {};\n",
  });
}

/** Effort tier rank for a tie-break: -low, then -medium, then -high, then no tier. */
function effortRank(id: string): number {
  const m = /-(low|medium|high)$/.exec(id);
  return m ? ["low", "medium", "high"].indexOf(m[1]!) : 3;
}

/**
 * Picks the cheapest model. Price is input plus output per million tokens from the
 * price table (an effort-suffixed id uses its base's rates, see ratesFor); models
 * with no price sort last; equal prices break by effort tier (low before medium
 * before high, so a tie never picks the dearest tier), then by id. Pure.
 */
export function cheapestModel(
  models: readonly ModelInfo[],
  prices: PricingTable["models"] = DEFAULT_PRICING.models,
): ModelInfo | undefined {
  const key = (m: ModelInfo): number => {
    const rates = ratesFor(m.id, prices);
    return rates ? rates.input_per_mtok + rates.output_per_mtok : Number.POSITIVE_INFINITY;
  };
  const sorted = [...models].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ra = effortRank(a.id);
    const rb = effortRank(b.id);
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0];
}

/**
 * Settings overlay for one live run: the harness's plan and work slots use `model`,
 * the planner and worker routes go to the harness, and the budgets are the caps.
 * `pricing` is the same table the model was picked from, so the run's cost is known
 * for that model. Returns a partial Settings (the file layer), not a full one.
 */
export function liveSettings(
  harness: LiveHarness,
  model: string,
  pricing?: PricingTable,
): Partial<Settings> {
  return {
    ...BIN_OVERLAY,
    ...(pricing ? { pricing } : {}),
    roles: {
      planner: { backend: harness, model },
      worker: { backend: harness, model },
    },
    profiles: {
      [harness]: { plan: { model }, work: { model } },
    },
    defaults: { planner_provider: harness, worker_provider: harness },
  };
}

/** A `failed` record with no run: used when nothing was spent. */
export function failedRecord(harness: LiveHarness, version: string): LiveRecord {
  return {
    harness,
    version,
    model: "-",
    run_id: "-",
    status: "failed",
    exit_code: null,
    cost_usd: 0,
    ts: new Date().toISOString(),
  };
}

/** The message for a harness whose model listing came back empty. */
export function emptyListingMessage(harness: LiveHarness): string {
  if (harness === "opencode") {
    return "opencode: 'opencode models --standalone' printed no models; configure a provider (for example log in with opencode) and re-run (nothing was spent)";
  }
  return `${harness}: its model listing returned no models; configure ${harness} and re-run (nothing was spent)`;
}

/**
 * Picks the model for one live run from a listing, using the price table the run's
 * settings also use. Fails before any run (appending a `failed` record with no
 * run) when the listing is empty or when no listed model has a price, because the
 * run cost could not then be checked against the cap.
 */
export function pickPricedModel(
  harness: LiveHarness,
  models: readonly ModelInfo[],
  prices: PricingTable["models"],
  version: string,
): ModelInfo {
  const cheapest = cheapestModel(models, prices);
  if (!cheapest) {
    appendRecord(failedRecord(harness, version));
    throw new Error(emptyListingMessage(harness));
  }
  if (!ratesFor(cheapest.id, prices)) {
    appendRecord(failedRecord(harness, version));
    const offered = models.map((m) => m.id).join(", ");
    throw new Error(
      `no listed model for ${harness} has a price, so the $${RUN_CAP_USD} cap cannot be enforced; ` +
        `add a rate for one of these ids under pricing.models in .substrate/settings.json (nothing was spent). ` +
        `Offered ids: ${offered}`,
    );
  }
  return cheapest;
}

/**
 * The model the owner named for one harness, from `SUBSTRATE_LIVE_MODEL_<HARNESS>`
 * (for example SUBSTRATE_LIVE_MODEL_OPENCODE). Trimmed; undefined when unset or blank.
 * When set, the live smoke skips the model listing and uses this id (see requirePricedOverride).
 */
export function liveModelOverride(
  harness: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[`SUBSTRATE_LIVE_MODEL_${harness.toUpperCase()}`]?.trim();
  return value ? value : undefined;
}

/**
 * Checks a named model override against the price table the run uses. Returns the id
 * when it is priced (an effort-suffixed id counts when its base is priced). When it is
 * unpriced, appends a `failed` record with no run and throws, before any model call.
 */
export function requirePricedOverride(
  harness: LiveHarness,
  id: string,
  prices: PricingTable["models"],
  version: string,
): string {
  if (!ratesFor(id, prices)) {
    appendRecord(failedRecord(harness, version));
    throw new Error(
      `SUBSTRATE_LIVE_MODEL_${harness.toUpperCase()}=${id} has no price, so the $${RUN_CAP_USD} cap cannot be enforced; ` +
        `add a rate for it under pricing.models in .substrate/settings.json (nothing was spent)`,
    );
  }
  return id;
}

/** Env var holding the llama.cpp endpoint for an opencode local-route live model. */
export const OPENCODE_BASE_URL_ENV = "SUBSTRATE_LIVE_OPENCODE_BASE_URL";

/** Same rule the OpenCode adapter uses to call a model local (id has "llama" or starts with "local"). */
export function isLocalRouteModel(model: string): boolean {
  return model.includes("llama") || model.startsWith("local");
}

/**
 * Settings for `.substrate/settings.local.json` in the toy repo, so the OpenCode adapter has a
 * provider with a base URL for a local-route model. The provider id is the part of the model id
 * before the first "/" (or "local"), and the model key is the rest, so `-m` maps to `<id>/<key>`.
 * Returns undefined for any non-opencode or non-local model (nothing to add). For a local model
 * with SUBSTRATE_LIVE_OPENCODE_BASE_URL unset, appends a `failed` record with no run and throws,
 * before any model call.
 */
export function liveLocalSettings(
  harness: LiveHarness,
  model: string,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Partial<Settings> | undefined {
  if (harness !== "opencode" || !isLocalRouteModel(model)) return undefined;
  const baseUrl = env[OPENCODE_BASE_URL_ENV]?.trim();
  if (!baseUrl) {
    appendRecord(failedRecord(harness, version));
    throw new Error(
      `${OPENCODE_BASE_URL_ENV} is required when the opencode live model is a local route (${model}); ` +
        `set it to the llama.cpp endpoint, for example http://<host>:<port>/v1 (nothing was spent)`,
    );
  }
  const bare = model.split("#")[0]!;
  const slash = bare.indexOf("/");
  const id = slash > 0 ? bare.slice(0, slash) : "local";
  const key = slash > 0 ? bare.slice(slash + 1) : bare;
  return {
    backends: {
      opencode: {
        provider: {
          id,
          npm: "@ai-sdk/openai-compatible",
          base_url: baseUrl,
          models: { [key]: {} },
        },
      },
    },
  };
}

/** Directory for failure evidence: next to the record file (see recordPath). */
export function evidenceRoot(): string {
  return join(dirname(recordPath()), "live-smoke-evidence");
}

const EVIDENCE_SKIP = /credential|secret|settings|auth|\.env/i;

/**
 * Copies the failure evidence of one live run into `<root>/<harness>-<ts>/`:
 * the toy repo's run directory (as runs/<run_id>/), its usage ledger if present,
 * and the CLI's stdout and stderr. Settings and credential-looking files are left out.
 * Call it before the toy repo is removed. Returns the directory.
 */
export function captureEvidence(opts: {
  harness: LiveHarness;
  repoDir: string;
  runDir: string | null;
  stdout: string;
  stderr: string;
  root: string;
  now?: Date;
}): string {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = join(opts.root, `${opts.harness}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  if (opts.runDir && existsSync(opts.runDir)) {
    cpSync(opts.runDir, join(dir, "runs", basename(opts.runDir)), {
      recursive: true,
      filter: (src) => statSync(src).isDirectory() || !EVIDENCE_SKIP.test(basename(src)),
    });
  }
  const usage = join(opts.repoDir, ".substrate", "ledger", "usage.jsonl");
  if (existsSync(usage)) copyFileSync(usage, join(dir, "usage.jsonl"));
  writeFileSync(join(dir, "cli-stdout.json"), opts.stdout, "utf8");
  writeFileSync(join(dir, "cli-stderr.txt"), opts.stderr, "utf8");
  return dir;
}

/** JSON of the first task.failed or run.failed event, truncated to 2000 characters. */
export function firstFailureEvent(events: RunSubstrateResult["events"]): string | null {
  const ev = events.find((e) => e.type === "task.failed" || e.type === "run.failed");
  if (!ev) return null;
  const json = JSON.stringify(ev);
  return json.length > 2000 ? `${json.slice(0, 2000)}...[truncated]` : json;
}

/** True when a live run met every check: exit 0, status finished, known cost, within the cap. */
export function isPassing(r: Pick<LiveRunResult, "exitCode" | "status" | "costKnown" | "costUsd">): boolean {
  return r.exitCode === 0 && r.status === "finished" && r.costKnown && r.costUsd <= RUN_CAP_USD;
}

/**
 * Path of the live record file. SUBSTRATE_LIVE_RECORDS overrides it (test/live only).
 * Other live-only variables: SUBSTRATE_LIVE_MODEL_<HARNESS> names the model for one harness (see liveModelOverride).
 */
export function recordPath(): string {
  const override = process.env.SUBSTRATE_LIVE_RECORDS;
  if (override) return override;
  return join(PROJECT_ROOT, ".substrate", "ledger", "live-smoke.json");
}

function readRecords(file: string): LiveRecord[] {
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`live record file ${file} is not a JSON array; refusing to overwrite it`);
  }
  return parsed as LiveRecord[];
}

/** Appends one record. Writes a temp file and renames it over the record file. */
export function appendRecord(rec: LiveRecord): string {
  const file = recordPath();
  const records = readRecords(file);
  records.push(rec);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return file;
}

/**
 * Settings the live test reads for version pins and the model list. The loaded
 * settings are the ones the CLI would use; the binaries are the bare PATH names.
 * The price table is merged in so its model ids are listed (the adapters report
 * settings and price-table ids, see knownModelIds in the registry).
 */
export async function probeSettings(): Promise<Settings> {
  const loaded = await loadSettings({ projectDir: PROJECT_ROOT });
  const withBins = deepMerge(loaded, BIN_OVERLAY) as Settings;
  return {
    ...withBins,
    pricing: {
      ...withBins.pricing,
      models: { ...DEFAULT_PRICING.models, ...(withBins.pricing?.models ?? {}) },
    },
  };
}

export interface LiveRunResult {
  exitCode: number;
  runId: string | null;
  status: string | null;
  costUsd: number;
  costKnown: boolean;
  stdout: string;
  stderr: string;
  passed: boolean;
  /** Evidence directory, set only when the run did not pass. */
  evidenceDir: string | null;
  /** JSON of the first task.failed / run.failed event, set only when the run did not pass. */
  failureEvent: string | null;
}

/** Text for an assertion message: the evidence directory and the first failure event. */
export function failureDetail(r: LiveRunResult): string {
  if (!r.evidenceDir) return "";
  return `\nevidence: ${r.evidenceDir}\nfirst failure event: ${r.failureEvent ?? "none in events.jsonl"}`;
}

/**
 * Runs the built CLI in plan mode on a fresh toy repo with SUBSTRATE_LIVE=1 and
 * returns its exit code and the run's real cost. The cost is usage.total_usd from
 * the CLI's JSON result. costKnown is false when any ledger row has an unknown cost.
 * `pricing` is the table the model was picked from; the run gets the same table.
 * When the run does not pass, its evidence is copied before the toy repo is removed.
 * `localSettings` (from liveLocalSettings) is written to the toy repo's .substrate/settings.local.json,
 * the only file a provider may be set in.
 */
export function runLive(
  harness: LiveHarness,
  model: string,
  pricing?: PricingTable,
  localSettings?: Partial<Settings>,
): LiveRunResult {
  const repo = createToyRepo();
  try {
    const res = runSubstrate({
      repo,
      settings: liveSettings(harness, model, pricing),
      beforeRun: localSettings
        ? (r) => {
            writeFileSync(
              join(r.dir, ".substrate", "settings.local.json"),
              JSON.stringify(localSettings, null, 2) + "\n",
              "utf8",
            );
          }
        : undefined,
      args: [
        "run",
        "--mode",
        "plan",
        "--permission-mode",
        "plan",
        "--output-format",
        "json",
        TOY_TASK,
      ],
      // runSubstrate swaps HOME for a temp dir; the real CLIs need the real one for their logins.
      env: { SUBSTRATE_LIVE: "1", HOME: homedir() },
      timeoutMs: 600_000,
    });
    try {
      let payload: { status?: string; run_id?: string; usage?: { total_usd?: number } } | null = null;
      try {
        payload = JSON.parse(res.stdout);
      } catch {
        payload = null;
      }
      const runId = payload?.run_id ?? null;
      const ledgerFile = join(repo.dir, ".substrate", "ledger", "usage.jsonl");
      const rows = existsSync(ledgerFile)
        ? readFileSync(ledgerFile, "utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as { run_id: string; cost_source: string })
            .filter((r) => runId !== null && r.run_id === runId)
        : [];
      const result: LiveRunResult = {
        exitCode: res.exitCode,
        runId,
        status: payload?.status ?? null,
        costUsd: payload?.usage?.total_usd ?? 0,
        // No rows means no recorded usage, which cannot back a real-cost claim.
        costKnown: rows.length > 0 && rows.every((r) => r.cost_source !== "unknown"),
        stdout: res.stdout,
        stderr: res.stderr,
        passed: false,
        evidenceDir: null,
        failureEvent: null,
      };
      result.passed = isPassing(result);
      if (!result.passed) {
        // Must run before res.cleanup() removes the toy repo.
        result.evidenceDir = captureEvidence({
          harness,
          repoDir: repo.dir,
          runDir: res.runDir,
          stdout: res.stdout,
          stderr: res.stderr,
          root: evidenceRoot(),
        });
        result.failureEvent = firstFailureEvent(res.events);
      }
      return result;
    } finally {
      res.cleanup();
    }
  } finally {
    // runSubstrate's cleanup removes the repo too; a second removal is harmless.
    repo.cleanup();
  }
}
