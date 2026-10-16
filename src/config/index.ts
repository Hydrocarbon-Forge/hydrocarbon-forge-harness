import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import * as Contracts from "../contracts/index.js";
import { matchGlob } from "../util/index.js";

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
}

export const DEFAULT_SETTINGS: Contracts.Settings = {
  backends: {},
  roles: {
    planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
  },
  routing: {
    feature: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    escalation: ["haiku", "sonnet", "opus"],
  },
  pricing: {
    asOf: "2026-10-16",
    sources: ["https://example.com"],
    models: {},
  },
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
  sandbox: { enabled: true, network: "deny" },
  git: { on_scope_violation: "revert", branch_prefix: "substrate/", auto_merge: false },
  instructions: { workers: "none" },
  execution: { strategy: "direct" },
};

export async function loadSettings(options: LoadSettingsOptions = {}): Promise<Contracts.Settings> {
  let merged: unknown = DEFAULT_SETTINGS;

  // 1. User config: userConfigDir/settings.json or ~/.config/substrate/settings.json
  const userDir = options.userConfigDir || path.join(os.homedir(), ".config", "substrate");
  const userFile = path.join(userDir, "settings.json");
  if (fs.existsSync(userFile)) {
    const content = fs.readFileSync(userFile, "utf8");
    const parsed = parseJsonc(content, userFile);
    merged = mergeSettings(merged, parsed);
  }

  // 2. Project config: projectDir/.substrate/settings.json
  const projectDir = options.projectDir || process.cwd();
  const projectFile = path.join(projectDir, ".substrate", "settings.json");
  if (fs.existsSync(projectFile)) {
    const content = fs.readFileSync(projectFile, "utf8");
    const parsed = parseJsonc(content, projectFile);
    merged = mergeSettings(merged, parsed);
  }

  // 3. Local project config: projectDir/.substrate/settings.local.json
  const localFile = path.join(projectDir, ".substrate", "settings.local.json");
  if (fs.existsSync(localFile)) {
    const content = fs.readFileSync(localFile, "utf8");
    const parsed = parseJsonc(content, localFile);
    merged = mergeSettings(merged, parsed);
  }

  // 4. CLI settings file: options.settingsFile
  if (options.settingsFile) {
    if (fs.existsSync(options.settingsFile)) {
      const content = fs.readFileSync(options.settingsFile, "utf8");
      const parsed = parseJsonc(content, options.settingsFile);
      merged = mergeSettings(merged, parsed);
    } else {
      throw new Error(`Settings file not found: ${options.settingsFile}`);
    }
  }

  // 5. Flags: options.flags
  if (options.flags) {
    merged = mergeSettings(merged, options.flags);
  }

  // Validate final
  return Contracts.Settings.parse(merged);
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
