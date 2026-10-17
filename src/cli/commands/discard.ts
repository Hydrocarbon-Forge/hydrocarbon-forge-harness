import { execFileSync } from "node:child_process";
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

export const discardCommand: CliCommand = {
  name: "discard",
  description: "Remove run worktrees and delete run branch",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0];
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }

    const worktreeDir = path.join(ctx.cwd, ".substrate", "worktrees", runId);
    if (fs.existsSync(worktreeDir)) {
      try {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      } catch (err: any) {
        ctx.stderr.write(`Warning: Failed to remove worktree dir: ${err.message}\n`);
      }
    }

    const branch = `substrate/runs/${runId}`;
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: ctx.cwd,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch {
      // Branch might not exist or already removed
    }

    ctx.stdout.write(`Discarded run ${runId}\n`);
    return 0;
  },
};

registry.register(discardCommand);
