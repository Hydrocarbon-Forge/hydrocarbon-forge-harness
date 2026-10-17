import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import { createSessionStore, type SessionStore } from "../../store/sessions.js";

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

export const sessionsCommand: CliCommand = {
  name: "sessions",
  description: "Display session history and latest prompt across sessions",
  async execute(ctx: CommandContext): Promise<number> {
    const sessionStore =
      ctx.sessionStore ??
      createSessionStore(path.join(ctx.cwd, ".substrate"));

    const sessions = await sessionStore.list();

    ctx.stdout.write(`=== Sessions History ===\n\n`);
    ctx.stdout.write(`Session ID\t\t\tCreated\t\t\tMode\tRuns\tLatest Prompt\n`);
    ctx.stdout.write(`----------------------------------------------------------------------------------------\n`);

    for (const s of sessions) {
      const latestPrompt =
        s.prompts && s.prompts.length > 0
          ? s.prompts[s.prompts.length - 1].prompt
          : "-";
      const runsCount = s.runs ? s.runs.length : 0;
      ctx.stdout.write(
        `${s.sessionId}\t${s.createdAt}\t${s.mode}\t${runsCount}\t${latestPrompt}\n`,
      );
    }

    return 0;
  },
};

registry.register(sessionsCommand);
