import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import { loadAgentDefinitions } from "../../config/index.js";
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

export const agentsCommand: CliCommand = {
  name: "agents",
  description: "Display defined agents and their configurations",
  async execute(ctx: CommandContext): Promise<number> {
    const { agents, errors } = await loadAgentDefinitions({
      projectDir: ctx.cwd,
    });

    if (errors.length > 0) {
      for (const err of errors) {
        ctx.stderr.write(`Warning in ${err.file ?? "agent"}: ${err.message}\n`);
      }
    }

    ctx.stdout.write(`=== Configured Agents ===\n\n`);
    ctx.stdout.write(`Name\t\tRole\tModel\t\tDescription\n`);
    ctx.stdout.write(`----------------------------------------------------------------\n`);

    for (const a of agents) {
      ctx.stdout.write(`${a.name}\t${a.role}\t${a.model ?? "-"}\t${a.description}\n`);
    }

    return 0;
  },
};

registry.register(agentsCommand);
