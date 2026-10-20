import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import * as Contracts from "../contracts/index.js";
import { deepMerge } from "../util/merge.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJsonc(text: string, filename = "settings.json"): unknown {
  if (typeof text !== "string") throw new Error(`Invalid text in ${filename}`);
  if (!text.trim()) return {};

  let out = "";
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      out += "  ";
      i += 2;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        out += " ";
        i++;
      }
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    out += c;
    i++;
  }

  // Strip trailing commas before } or ]
  out = out.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`Failed to parse JSONC in ${filename}: ${(err as Error).message}`);
  }
}

export interface LoadSettingsOptions {
  projectDir?: string;
  userConfigDir?: string;
  settingsFile?: string;
  flags?: Partial<Contracts.Settings>;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_SETTINGS: Contracts.Settings & { pricing: Contracts.PricingTable } = {
  backends: {},
  roles: {
    planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    worker: { backend: "claude", model: "claude-sonnet-5-5" },
  },
  routing: {
    feature: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    escalation: ["haiku", "sonnet", "opus"],
  },
  pricing: {
    models: {},
  } as unknown as Contracts.PricingTable,
  budgets: {
    run: { max_usd: 5 },
    task: { max_usd: 0.5 },
    l1_replans_per_task: 2,
    l2_per_run: 2,
    planner_format_retries: 2,
    approval_threshold_usd: 2,
  },
  concurrency: { workers: 3 },
  permissions: { allow: [], deny: [] },
  sandbox: { enabled: false },
  git: { on_scope_violation: "revert", auto_merge: false },
  instructions: { workers: "none" },
  usage: { global: true },
  execution: { strategy: "direct" },
};

export function sandboxProblem(
  settings: Contracts.Settings,
  which?: (bin: string) => boolean,
): string | null {
  if (!settings.sandbox?.enabled) return null;
  let hasBwrap: boolean;
  if (which) {
    hasBwrap = which("bwrap");
  } else {
    try {
      execFileSync("bwrap", ["--version"], { stdio: "ignore" });
      hasBwrap = true;
    } catch {
      hasBwrap = false;
    }
  }
  if (hasBwrap) return null;
  return "sandbox.enabled is true but bwrap is not installed; install bubblewrap or set sandbox.enabled to false";
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function readEnvLayer(env: NodeJS.ProcessEnv): {
  settings: Partial<Contracts.Settings>;
  runDefaults: { permissionMode?: Contracts.PermissionMode; outputFormat?: "text" | "json" | "stream-json" };
} {
  // SUBSTRATE_LIVE is consumed by the test batteries only and is never read here or anywhere in src/.
  // Built as a partial object: only the keys set by env are present, so lower layers keep their values.
  const settings: Record<string, unknown> = {};
  const runDefaults: {
    permissionMode?: Contracts.PermissionMode;
    outputFormat?: "text" | "json" | "stream-json";
  } = {};

  const maxBudget = envValue(env, "SUBSTRATE_MAX_BUDGET_USD");
  if (maxBudget !== undefined) {
    const n = Number(maxBudget);
    if (!Number.isFinite(n)) {
      throw new Error("SUBSTRATE_MAX_BUDGET_USD must be a number");
    }
    settings.budgets = { run: { max_usd: n } };
  }

  const model = envValue(env, "SUBSTRATE_MODEL");
  const workerModel = envValue(env, "SUBSTRATE_WORKER_MODEL");
  if (model !== undefined || workerModel !== undefined) {
    // SUBSTRATE_MODEL maps to the planner route only.
    const roles: Record<string, unknown> = {};
    if (model !== undefined) roles.planner = { model };
    if (workerModel !== undefined) roles.worker = { model: workerModel };
    settings.roles = roles;
  }

  const permissionMode = envValue(env, "SUBSTRATE_PERMISSION_MODE");
  if (permissionMode !== undefined) {
    const valid: string[] = ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"];
    if (!valid.includes(permissionMode)) {
      throw new Error(
        `Invalid SUBSTRATE_PERMISSION_MODE: ${permissionMode}; must be one of default, plan, acceptEdits, dontAsk, bypassPermissions`,
      );
    }
    runDefaults.permissionMode = permissionMode as Contracts.PermissionMode;
  }

  const outputFormat = envValue(env, "SUBSTRATE_OUTPUT_FORMAT");
  if (outputFormat === "text" || outputFormat === "json" || outputFormat === "stream-json") {
    runDefaults.outputFormat = outputFormat;
  }

  return { settings: settings as Partial<Contracts.Settings>, runDefaults };
}

export interface SettingsLayers {
  user?: { path: string; value: Record<string, unknown> };
  project?: { path: string; value: Record<string, unknown> };
  local?: { path: string; value: Record<string, unknown> };
  explicit?: { path: string; value: Record<string, unknown> };
  env: Record<string, unknown>;
  flags?: Record<string, unknown>;
}

function readLayerFile(file: string): Record<string, unknown> {
  const parsed = parseJsonc(fs.readFileSync(file, "utf8"), file);
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid settings in ${file}: expected a JSON object`);
  }
  return parsed;
}

export async function settingsLayers(options: LoadSettingsOptions = {}): Promise<SettingsLayers> {
  const env = options.env ?? process.env;
  const layers: SettingsLayers = { env: readEnvLayer(env).settings };

  // 1. User file: <SUBSTRATE_CONFIG_DIR | options.userConfigDir | ~/.config/substrate>/settings.json
  const userDir =
    envValue(env, "SUBSTRATE_CONFIG_DIR") ||
    options.userConfigDir ||
    path.join(os.homedir(), ".config", "substrate");
  const userFile = path.join(userDir, "settings.json");
  if (fs.existsSync(userFile)) {
    layers.user = { path: userFile, value: readLayerFile(userFile) };
  }

  // 2/3. Project files: <SUBSTRATE_PROJECT_DIR | options.projectDir | cwd>/.substrate/{settings,settings.local}.json
  const projectDir = envValue(env, "SUBSTRATE_PROJECT_DIR") || options.projectDir || process.cwd();
  const projectFile = path.join(projectDir, ".substrate", "settings.json");
  if (fs.existsSync(projectFile)) {
    layers.project = { path: projectFile, value: readLayerFile(projectFile) };
  }
  const localFile = path.join(projectDir, ".substrate", "settings.local.json");
  if (fs.existsSync(localFile)) {
    layers.local = { path: localFile, value: readLayerFile(localFile) };
  }

  // 4. Explicit file: --settings flag wins over SUBSTRATE_SETTINGS.
  const explicit = options.settingsFile || envValue(env, "SUBSTRATE_SETTINGS");
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`Settings file not found: ${explicit}`);
    }
    layers.explicit = { path: explicit, value: readLayerFile(explicit) };
  }

  // 5. Flags: options.flags
  if (options.flags) {
    layers.flags = options.flags as Record<string, unknown>;
  }

  return layers;
}

function mergeOverlay(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged = deepMerge(base, overlay);
  return overlay.pricing !== undefined ? { ...merged, pricing: overlay.pricing } : merged;
}

export function foldLayers(layers: SettingsLayers): Record<string, unknown> {
  let merged: Record<string, unknown> = DEFAULT_SETTINGS as Record<string, unknown>;
  const slots: Array<Record<string, unknown> | undefined> = [
    layers.user?.value,
    layers.project?.value,
    layers.local?.value,
    layers.explicit?.value,
    layers.env,
    layers.flags,
  ];
  for (const slot of slots) {
    if (slot !== undefined) {
      merged = mergeOverlay(merged, slot);
    }
  }
  return merged;
}

function hasOpencodeProvider(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const backends = (obj as Record<string, unknown>).backends;
  if (!backends || typeof backends !== "object") return false;
  const opencode = (backends as Record<string, unknown>).opencode;
  if (!opencode || typeof opencode !== "object") return false;
  return (opencode as Record<string, unknown>).provider !== undefined;
}

export function assertNoProviderOutsideLocal(layers: SettingsLayers): void {
  const nonLocalSlots: Array<Record<string, unknown> | undefined> = [
    layers.user?.value,
    layers.project?.value,
    layers.env,
    layers.flags,
  ];
  if (layers.explicit && !layers.explicit.path.endsWith("settings.local.json")) {
    nonLocalSlots.push(layers.explicit.value);
  }
  for (const slot of nonLocalSlots) {
    if (hasOpencodeProvider(slot)) {
      throw new Error(
        "backends.opencode.provider may only be set in .substrate/settings.local.json"
      );
    }
  }
}

export async function loadSettings(options: LoadSettingsOptions = {}): Promise<Contracts.Settings> {
  const layers = await settingsLayers(options);
  assertNoProviderOutsideLocal(layers);
  const merged = foldLayers(layers);
  const settings = Contracts.Settings.parse(merged);
  validateProfiles(settings);
  return settings;
}

// DECISIONS A3: a defaults entry that names a provider must have a profile for it.
export function validateProfiles(settings: Contracts.Settings): void {
  if (!settings.defaults) return;
  const profiles = settings.profiles ?? {};

  const planner = settings.defaults.planner_provider;
  if (planner !== undefined && !profiles[planner]) {
    throw new Error(
      `profiles.${planner} is required because defaults.planner_provider is "${planner}"`,
    );
  }

  const worker = settings.defaults.worker_provider;
  if (worker !== undefined && !profiles[worker]) {
    throw new Error(
      `profiles.${worker} is required because defaults.worker_provider is "${worker}"`,
    );
  }
}

export function modelCacheFile(projectRoot: string): string {
  return path.join(projectRoot, ".substrate", "state", "models.json");
}
