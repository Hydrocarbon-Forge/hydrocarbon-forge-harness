import type { Effort, Engine, PermissionMode } from "../contracts/index.js";
import type { SessionStore } from "../store/sessions.js";

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

export class CommandRegistry {
  private readonly commands = new Map<string, CliCommand>();

  register(cmd: CliCommand): void {
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  get(name: string): CliCommand | undefined {
    return this.commands.get(name);
  }

  list(): CliCommand[] {
    const unique = new Set(this.commands.values());
    return Array.from(unique);
  }
}

export const registry = new CommandRegistry();

export async function dispatchCommand(
  args: string[],
  ctx: Partial<CommandContext>,
): Promise<number> {
  const fullCtx: CommandContext = {
    cwd: ctx.cwd ?? process.cwd(),
    flags: ctx.flags ?? {},
    rawArgs: ctx.rawArgs ?? args,
    stdin: ctx.stdin,
    stdout: ctx.stdout ?? (process.stdout as NodeJS.WriteStream),
    stderr: ctx.stderr ?? (process.stderr as NodeJS.WriteStream),
    engine: ctx.engine,
    sessionStore: ctx.sessionStore,
  };

  const cmdName = args[0];
  const cmd = cmdName ? registry.get(cmdName) : undefined;
  if (!cmd) {
    fullCtx.stderr.write(`Error: Unknown command "${cmdName}".\n`);
    return 2;
  }
  return cmd.execute(fullCtx);
}
