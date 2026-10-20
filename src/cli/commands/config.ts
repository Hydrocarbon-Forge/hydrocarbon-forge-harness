import fs from "node:fs";
import path from "node:path";

import * as Contracts from "../../contracts/index.js";
import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { foldLayers, loadSettings, parseJsonc, settingsLayers } from "../../config/index.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  local?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
}

export type ParsedCliFlags = CliGlobalFlags & CliGovernanceFlags;

export interface CommandContext {
  cwd: string;
  flags: ParsedCliFlags;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: Engine;
  sessionStore?: SessionStore;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);

function getNested(obj: any, keyPath: string): any {
  const parts = keyPath.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setNested(obj: any, keyPath: string, value: any): void {
  const parts = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cur[part] !== "object" || cur[part] === null) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

// Strips the Zod wrappers that do not change the shape of a value.
function unwrapZod(schema: any): any {
  let cur = schema;
  while (cur?._def) {
    const t = cur._def.typeName;
    if (t === "ZodOptional" || t === "ZodNullable" || t === "ZodDefault") cur = cur._def.innerType;
    else if (t === "ZodEffects") cur = cur._def.schema;
    else break;
  }
  return cur;
}

// True when the path names a place in the settings schema. Record maps accept any
// key (wildcards such as pricing.models.<id>.*), unions accept a path through any
// option, and a leaf accepts nothing below it.
function isSchemaPath(schema: any, parts: string[]): boolean {
  if (parts.length === 0) return true;
  const node = unwrapZod(schema);
  const typeName = node?._def?.typeName;
  const [head, ...rest] = parts;
  switch (typeName) {
    case "ZodObject":
      return Object.prototype.hasOwnProperty.call(node.shape, head) && isSchemaPath(node.shape[head], rest);
    case "ZodRecord":
      return head !== "" && isSchemaPath(node._def.valueType, rest);
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return node._def.options.some((opt: any) => isSchemaPath(opt, parts));
    case "ZodArray":
      return /^\d+$/.test(head) && isSchemaPath(node._def.type, rest);
    case "ZodAny":
    case "ZodUnknown":
      return true;
    default:
      return false;
  }
}

/** True when a dotted key names a settings key in the Settings schema (set or unset). */
export function isKnownSettingsKey(key: string): boolean {
  return isSchemaPath(Contracts.Settings, key.split("."));
}

// Writes the unknown-key error: a stderr line with a hint in text mode, the usual
// one-line error object on stdout in json mode.
function reportUnknownKey(ctx: CommandContext, key: string): void {
  const msg = `unknown settings key: ${key}`;
  if (ctx.flags.outputFormat === "json") {
    ctx.stdout.write(JSON.stringify({ error: `${msg}. Run substrate config list to see the settings keys.` }) + "\n");
  } else {
    ctx.stderr.write(`Error: ${msg}\nHint: run substrate config list to see the settings keys.\n`);
  }
}

function parseVal(v: string): any {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  const num = Number(v);
  if (!isNaN(num) && v.trim() !== "") return num;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// Indented JSON in text mode; one compact line in json mode.
function jsonText(ctx: CommandContext, value: unknown): string {
  return ctx.flags.outputFormat === "json" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

export const configCommand: CliCommand = {
  name: "config",
  description: "Inspect or update project configuration settings",
  async execute(ctx: CommandContext): Promise<number> {
    const sub = ctx.rawArgs[0];

    if (sub === "set") {
      const key = ctx.rawArgs[1];
      const rawVal = ctx.rawArgs[2];
      if (!key || rawVal === undefined) {
        ctx.stderr.write("Usage: substrate config set <key> <val> [--local]\n");
        return 2;
      }
      const val = parseVal(rawVal);
      const targetPath = path.join(ctx.cwd, ".substrate", ctx.flags.local ? "settings.local.json" : "settings.json");

      // Read only the target file's own content (missing file starts from empty).
      let target: Record<string, any> = {};
      if (fs.existsSync(targetPath)) {
        target = parseJsonc(fs.readFileSync(targetPath, "utf8"), targetPath) as Record<string, any>;
      }
      setNested(target, key, val);

      // Validate the merged result before writing anything.
      let layers;
      try {
        layers = await settingsLayers({ projectDir: ctx.cwd, settingsFile: ctx.flags.settings });
      } catch (err) {
        ctx.stderr.write(`Error: ${(err as Error).message}\n`);
        return 2;
      }
      if (ctx.flags.local) {
        layers.local = { path: targetPath, value: target };
      } else {
        layers.project = { path: targetPath, value: target };
      }
      const result = Contracts.Settings.safeParse(foldLayers(layers));
      if (!result.success) {
        ctx.stderr.write(`Invalid setting ${key}: ${result.error.issues[0]?.message ?? "invalid"}\n`);
        return 2;
      }

      const substrateDir = path.join(ctx.cwd, ".substrate");
      if (!fs.existsSync(substrateDir)) {
        fs.mkdirSync(substrateDir, { recursive: true });
      }
      fs.writeFileSync(targetPath, JSON.stringify(target, null, 2), "utf8");
      ctx.stdout.write(`Set ${key} = ${JSON.stringify(val)}\n`);
      return 0;
    }

    const loadMerged = async (): Promise<Contracts.Settings | null> => {
      try {
        return await loadSettings({ projectDir: ctx.cwd, settingsFile: ctx.flags.settings });
      } catch (err) {
        ctx.stderr.write(`Error: ${(err as Error).message}\n`);
        return null;
      }
    };

    if (sub === "get") {
      const key = ctx.rawArgs[1];
      if (!key) {
        ctx.stderr.write("Usage: substrate config get <key>\n");
        return 2;
      }
      if (!isKnownSettingsKey(key)) {
        reportUnknownKey(ctx, key);
        return 2;
      }
      const settings = await loadMerged();
      if (settings === null) return 2;
      const val = getNested(settings, key);
      if (val === undefined) {
        ctx.stdout.write(`undefined\n`);
      } else {
        ctx.stdout.write(typeof val === "object" ? jsonText(ctx, val) + "\n" : `${val}\n`);
      }
      return 0;
    }

    if (sub === "list" || !sub) {
      const settings = await loadMerged();
      if (settings === null) return 2;
      ctx.stdout.write(jsonText(ctx, settings) + "\n");
      return 0;
    }

    ctx.stderr.write(`Unknown config operation: ${sub}\n`);
    return 2;
  },
};

registry.register(configCommand);
