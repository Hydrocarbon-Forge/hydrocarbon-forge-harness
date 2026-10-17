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

export const undoCommand: CliCommand = {
  name: "undo",
  description: "Revert run branch to prior batch checkpoint ref",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0];
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }

    const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
    const eventsFile = path.join(runDir, "events.jsonl");

    let checkpointRef = "HEAD~1";
    if (fs.existsSync(eventsFile)) {
      const content = fs.readFileSync(eventsFile, "utf8");
      const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]);
          if (ev.type === "batch.merged" && ev.data?.checkpoint_ref) {
            checkpointRef = ev.data.checkpoint_ref;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    const branch = `substrate/runs/${runId}`;
    try {
      execFileSync("git", ["branch", "-f", branch, checkpointRef], {
        cwd: ctx.cwd,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch {
      try {
        const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
          cwd: ctx.cwd,
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
        if (rootCommit) {
          execFileSync("git", ["branch", "-f", branch, rootCommit], {
            cwd: ctx.cwd,
            encoding: "utf8",
            stdio: "pipe",
          });
        }
      } catch {
        // ignore
      }
    }

    ctx.stdout.write(`Reverted branch ${branch} to ${checkpointRef}\n`);
    return 0;
  },
};

registry.register(undoCommand);
