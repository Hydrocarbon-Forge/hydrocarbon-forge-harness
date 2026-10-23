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
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
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

    const rows = sessions.map((s) => ({
      id: s.sessionId,
      mode: s.mode,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      runs: s.runs ? s.runs.length : 0,
      latest_prompt:
        s.prompts && s.prompts.length > 0
          ? s.prompts[s.prompts.length - 1].prompt
          : "-",
    }));

    if (ctx.flags.outputFormat === "json") {
      ctx.stdout.write(JSON.stringify({ sessions: rows }) + "\n");
      return 0;
    }

    ctx.stdout.write(`=== Sessions History ===\n\n`);
    ctx.stdout.write(`Session ID\t\t\tCreated\t\t\tMode\tRuns\tLatest Prompt\n`);
    ctx.stdout.write(`----------------------------------------------------------------------------------------\n`);

    for (const row of rows) {
      ctx.stdout.write(
        `${row.id}\t${row.created_at}\t${row.mode}\t${row.runs}\t${row.latest_prompt}\n`,
      );
    }

    return 0;
  },
};

registry.register(sessionsCommand);
