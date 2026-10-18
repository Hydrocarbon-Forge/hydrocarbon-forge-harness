import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import { listAgents } from "../../prompts/index.js";
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
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
  from?: string;
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
  description: "List agent prompt sources (project, user, built-in)",
  async execute(ctx: CommandContext): Promise<number> {
    if (ctx.rawArgs[0] === "import") {
      const from = ctx.flags.from;
      if (from === undefined) {
        ctx.stderr.write("Error: --from is required\n");
        return 2;
      }
      if (from !== "claude" && from !== "opencode") {
        ctx.stderr.write("Error: --from must be claude or opencode\n");
        return 2;
      }
      const { runAgentsImport } = await import(`../agents-import.js`);
      const report = await runAgentsImport({
        from: from as "claude" | "opencode",
        cwd: ctx.cwd,
      });

      if (report.errors.length > 0) {
        for (const err of report.errors) {
          ctx.stderr.write(`Error: ${err}\n`);
        }
        if (report.errors.some((e) => e.includes("Source directory does not exist"))) {
          return 2;
        }
        return 1;
      }

      ctx.stdout.write(`=== Agents Import Summary ===\n`);
      ctx.stdout.write(`Imported: ${report.imported.length} (${report.imported.join(", ") || "none"})\n`);
      ctx.stdout.write(`Skipped:  ${report.skipped.length} (${report.skipped.join(", ") || "none"})\n`);

      return 0;
    }

    const agents = listAgents({ projectRoot: ctx.cwd });
    for (const a of agents) {
      ctx.stdout.write(`${a.role} ${a.source} ${a.path}\n`);
    }
    return 0;
  },
};

registry.register(agentsCommand);
