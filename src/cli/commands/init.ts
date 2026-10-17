import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import { DEFAULT_SETTINGS } from "../../config/index.js";
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

export const initCommand: CliCommand = {
  name: "init",
  description: "Initialize Substrate repository workspace, directories, and default settings",
  async execute(ctx: CommandContext): Promise<number> {
    const substrateDir = path.join(ctx.cwd, ".substrate");
    const subDirs = ["sessions", "state", "runs", "worktrees"];

    for (const sub of subDirs) {
      fs.mkdirSync(path.join(substrateDir, sub), { recursive: true });
    }

    const settingsPath = path.join(substrateDir, "settings.json");
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify(DEFAULT_SETTINGS, null, 2),
        "utf8",
      );
    }

    const gitDir = path.join(ctx.cwd, ".git");
    if (fs.existsSync(gitDir)) {
      const excludeDir = path.join(gitDir, "info");
      fs.mkdirSync(excludeDir, { recursive: true });
      const excludePath = path.join(excludeDir, "exclude");
      let content = fs.existsSync(excludePath)
        ? fs.readFileSync(excludePath, "utf8")
        : "";
      if (!content.includes(".substrate")) {
        if (content.length > 0 && !content.endsWith("\n")) {
          content += "\n";
        }
        content += ".substrate/\n";
        fs.writeFileSync(excludePath, content, "utf8");
      }
    }

    ctx.stdout.write("Substrate project workspace initialized successfully.\n");
    return 0;
  },
};

registry.register(initCommand);
