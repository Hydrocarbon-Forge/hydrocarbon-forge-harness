import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";

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
  noGovernor?: boolean;
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

export const configCommand: CliCommand = {
  name: "config",
  description: "Inspect or update project configuration settings",
  async execute(ctx: CommandContext): Promise<number> {
    const sub = ctx.rawArgs[0];
    const settingsPath = path.join(ctx.cwd, ".substrate", "settings.json");

    let current: Record<string, any> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch {
        current = {};
      }
    }

    if (sub === "set") {
      const key = ctx.rawArgs[1];
      const rawVal = ctx.rawArgs[2];
      if (!key || rawVal === undefined) {
        ctx.stderr.write("Usage: substrate config set <key> <val>\n");
        return 2;
      }
      const val = parseVal(rawVal);
      setNested(current, key, val);

      const substrateDir = path.join(ctx.cwd, ".substrate");
      if (!fs.existsSync(substrateDir)) {
        fs.mkdirSync(substrateDir, { recursive: true });
      }
      fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2), "utf8");
      ctx.stdout.write(`Set ${key} = ${JSON.stringify(val)}\n`);
      return 0;
    }

    if (sub === "get") {
      const key = ctx.rawArgs[1];
      if (!key) {
        ctx.stderr.write("Usage: substrate config get <key>\n");
        return 2;
      }
      const val = getNested(current, key);
      if (val === undefined) {
        ctx.stdout.write(`undefined\n`);
      } else {
        ctx.stdout.write(typeof val === "object" ? JSON.stringify(val, null, 2) + "\n" : `${val}\n`);
      }
      return 0;
    }

    if (sub === "list" || !sub) {
      ctx.stdout.write(JSON.stringify(current, null, 2) + "\n");
      return 0;
    }

    ctx.stderr.write(`Unknown config operation: ${sub}\n`);
    return 2;
  },
};

registry.register(configCommand);
