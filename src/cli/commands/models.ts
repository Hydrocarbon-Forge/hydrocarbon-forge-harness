import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import { loadSettings } from "../../config/index.js";
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

export const modelsCommand: CliCommand = {
  name: "models",
  description: "Display model routing table and escalation chain",
  async execute(ctx: CommandContext): Promise<number> {
    const settings = await loadSettings({
      projectDir: ctx.cwd,
      settingsFile: ctx.flags.settings,
    });

    ctx.stdout.write(`=== Model Routing Table ===\n\n`);
    ctx.stdout.write(`Task Class\tBackend\tModel\t\t\tEffort\n`);
    ctx.stdout.write(`----------------------------------------------------------------\n`);

    const routing = settings.routing ?? {};
    for (const [cls, route] of Object.entries(routing)) {
      if (cls === "escalation") continue;
      const r = route as any;
      ctx.stdout.write(`${cls}\t\t${r.backend ?? "-"}\t${r.model ?? "-"}\t${r.effort ?? "-"}\n`);
    }

    if (routing.escalation && Array.isArray(routing.escalation)) {
      ctx.stdout.write(`\nEscalation Chain: ${routing.escalation.join(" -> ")}\n`);
    }

    ctx.stdout.write(`\nRoles:\n`);
    for (const [role, conf] of Object.entries(settings.roles ?? {})) {
      const c = conf as any;
      ctx.stdout.write(`  ${role}: ${c.backend} / ${c.model} (${c.effort ?? "medium"})\n`);
    }

    return 0;
  },
};

registry.register(modelsCommand);
