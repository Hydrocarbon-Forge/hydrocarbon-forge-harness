import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import * as Contracts from "../contracts/index.js";
import { matchGlob } from "../util/index.js";
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

export function mergeSettings(base?: unknown, overlay?: unknown): unknown {
  if (base === undefined) return overlay;
  if (overlay === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return overlay;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(overlay)) {
    if (key === "pricing") {
      result[key] = val;
    } else if (key in result && isPlainObject(result[key]) && isPlainObject(val)) {
      result[key] = mergeSettings(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function applyOverlay(
  settings: Contracts.Settings,
  overlay: Partial<Contracts.Settings>,
): Contracts.Settings {
  const merged = mergeSettings(settings, overlay);
  return Contracts.Settings.parse(merged);
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
    worker: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
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
  sandbox: { enabled: false, network: "deny" },
  git: { on_scope_violation: "revert", branch_prefix: "substrate/", auto_merge: false },
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

export async function loadSettings(options: LoadSettingsOptions = {}): Promise<Contracts.Settings> {
  const merged = foldLayers(await settingsLayers(options));
  return Contracts.Settings.parse(merged);
}

export function modelCacheFile(projectRoot: string): string {
  return path.join(projectRoot, ".substrate", "state", "models.json");
}

// ===== permissions =====
export function parsePermissionRule(rule: string): { tool: string; pattern: string | null } {
  if (typeof rule !== "string") throw new Error("Rule must be a string");
  const trimmed = rule.trim();
  if (!trimmed) throw new Error("Empty permission rule");
  const match = trimmed.match(/^([A-Za-z0-9_-]+)(?:\((.*)\))?$/);
  if (!match) throw new Error(`Malformed permission rule: ${rule}`);
  const tool = match[1];
  const pattern = match[2] !== undefined ? match[2] : null;
  return { tool, pattern };
}

export function matchPermissionRule(rule: string, toolCall: string): boolean {
  if (!rule || !toolCall) return false;
  let parsedRule;
  try {
    parsedRule = parsePermissionRule(rule);
  } catch {
    return false;
  }
  let parsedCall;
  try {
    parsedCall = parsePermissionRule(toolCall);
  } catch {
    return false;
  }
  if (parsedRule.tool !== parsedCall.tool) return false;
  if (parsedRule.pattern === null) return true;
  if (parsedCall.pattern === null) return false;
  return matchGlob(parsedRule.pattern, parsedCall.pattern);
}

const DANGEROUS_PATTERNS = [
  "Agent",
  "Agent(*)",
  "Bash(git commit*)",
  "Bash(git push*)",
  "Bash(git checkout*)",
  "Bash(git reset*)",
  "Bash(git rebase*)",
  "Bash(git clean*)",
  "Bash(git branch*)",
  "Bash(git stash*)",
  "Bash(git merge*)",
  "WebFetch",
  "WebFetch(*)",
  "WebSearch",
  "WebSearch(*)",
];

export function evaluatePermission(
  toolCall: string,
  permissions: { allow?: string[]; ask?: string[]; deny?: string[] },
): "allow" | "ask" | "deny" {
  if (Array.isArray(permissions.deny)) {
    for (const rule of permissions.deny) {
      if (matchPermissionRule(rule, toolCall)) return "deny";
    }
  }
  if (Array.isArray(permissions.ask)) {
    for (const rule of permissions.ask) {
      if (matchPermissionRule(rule, toolCall)) return "ask";
    }
  }
  if (Array.isArray(permissions.allow)) {
    for (const rule of permissions.allow) {
      if (matchPermissionRule(rule, toolCall)) return "allow";
    }
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (matchPermissionRule(pattern, toolCall)) return "deny";
  }
  return "ask";
}

export function evaluateWorkerPermission(
  toolCall: string,
  permissions: { allow?: string[]; ask?: string[]; deny?: string[] },
): "allow" | "deny" {
  const verdict = evaluatePermission(toolCall, permissions);
  return verdict === "allow" ? "allow" : "deny";
}

// ===== definitions loader =====
export interface AgentDefinition {
  name: string;
  description: string;
  role: Contracts.RoleName;
  backend?: Contracts.BackendName;
  model?: string;
  effort?: Contracts.Effort;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: Contracts.PermissionMode;
  maxTurns?: number;
  budget?: Contracts.Budget;
  body?: string;
}

export interface LoadAgentDefinitionsOptions {
  projectDir?: string;
  userConfigDir?: string;
  builtinsDir?: string;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };
  try {
    const frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
    return { frontmatter, body: match[2].trim() };
  } catch {
    return { frontmatter: null, body: content };
  }
}

function findAgentDir(dirCandidate?: string, subDir = ""): string | null {
  if (!dirCandidate) return null;
  const target = subDir ? path.join(dirCandidate, subDir) : dirCandidate;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return target;
  }
  return null;
}

export async function loadAgentDefinitions(
  options: LoadAgentDefinitionsOptions = {},
): Promise<{ agents: AgentDefinition[]; errors: Array<{ file?: string; message: string }> }> {
  const errors: Array<{ file?: string; message: string }> = [];
  const agents: AgentDefinition[] = [];
  const seenNames = new Set<string>();

  // Precedence: project over user over builtin
  const layers: Array<{ name: string; dir: string | null }> = [
    {
      name: "project",
      dir: options.projectDir ? findAgentDir(options.projectDir, ".substrate/agents") : null,
    },
    {
      name: "user",
      dir: options.userConfigDir
        ? findAgentDir(options.userConfigDir, "agents") || findAgentDir(options.userConfigDir)
        : null,
    },
    {
      name: "builtin",
      dir: options.builtinsDir
        ? findAgentDir(options.builtinsDir, "agents") || findAgentDir(options.builtinsDir)
        : null,
    },
  ];

  for (const layer of layers) {
    if (!layer.dir) continue;
    const layerNames = new Set<string>();
    const files = fs.readdirSync(layer.dir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      const full = path.join(layer.dir, file);
      const content = fs.readFileSync(full, "utf8");
      const { frontmatter, body } = parseFrontmatter(content);

      if (!frontmatter) {
        errors.push({ file: full, message: "Missing or malformed frontmatter" });
        continue;
      }

      const { name, description, role } = frontmatter;
      if (!name || typeof name !== "string" || !description || typeof description !== "string") {
        errors.push({ file: full, message: "Missing name or description" });
        continue;
      }

      const roleResult = Contracts.RoleName.safeParse(role);
      if (!roleResult.success) {
        errors.push({ file: full, message: `Invalid role: ${String(role)}` });
        continue;
      }

      if (layerNames.has(name)) {
        errors.push({ file: full, message: `Duplicate agent name in layer ${layer.name}: ${name}` });
        continue;
      }
      layerNames.add(name);

      if (!seenNames.has(name)) {
        seenNames.add(name);
        agents.push({
          name,
          description,
          role: roleResult.data,
          backend: frontmatter.backend as Contracts.BackendName | undefined,
          model: frontmatter.model as string | undefined,
          effort: frontmatter.effort as Contracts.Effort | undefined,
          tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : undefined,
          disallowedTools: Array.isArray(frontmatter.disallowedTools)
            ? frontmatter.disallowedTools
            : undefined,
          permissionMode: frontmatter.permissionMode as Contracts.PermissionMode | undefined,
          maxTurns: typeof frontmatter.maxTurns === "number" ? frontmatter.maxTurns : undefined,
          budget: frontmatter.budget as Contracts.Budget | undefined,
          body,
        });
      }
    }
  }

  return { agents, errors };
}

// ===== discovery stubs: commands and skills =====
export interface CommandSummary {
  name: string;
  description?: string;
  "argument-hint"?: string;
  model?: string;
  [key: string]: unknown;
}

export async function discoverCommands(dir: string): Promise<CommandSummary[]> {
  if (!dir || !fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: CommandSummary[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const full = path.join(dir, entry.name);
      const content = fs.readFileSync(full, "utf8");
      const { frontmatter } = parseFrontmatter(content);
      const name = entry.name.slice(0, -3);
      const summary: CommandSummary = { name };
      if (frontmatter) {
        if (typeof frontmatter["description"] === "string") {
          summary.description = frontmatter["description"];
        }
        if (typeof frontmatter["argument-hint"] === "string") {
          summary["argument-hint"] = frontmatter["argument-hint"];
        }
        if (typeof frontmatter["model"] === "string") {
          summary.model = frontmatter["model"];
        }
      }
      out.push(summary);
    }
  }
  return out;
}

export interface SkillSummary {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export async function discoverSkills(dir: string): Promise<SkillSummary[]> {
  if (!dir || !fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: SkillSummary[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, "utf8");
        const { frontmatter } = parseFrontmatter(content);
        const name =
          frontmatter && typeof frontmatter["name"] === "string"
            ? frontmatter["name"]
            : entry.name;
        const description =
          frontmatter && typeof frontmatter["description"] === "string"
            ? frontmatter["description"]
            : undefined;
        out.push({ name, description });
      }
    }
  }
  return out;
}
