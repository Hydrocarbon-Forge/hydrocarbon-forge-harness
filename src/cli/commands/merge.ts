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

export const mergeCommand: CliCommand = {
  name: "merge",
  description: "Merge finished run branch into current branch",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0];
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }

    const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
    const eventsFile = path.join(runDir, "events.jsonl");

    if (fs.existsSync(eventsFile)) {
      const content = fs.readFileSync(eventsFile, "utf8");
      const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);
      let isFinished = false;
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "run.finished" || ev.data?.status === "finished" || ev.data?.state === "finished") {
            isFinished = true;
          }
        } catch {
          // ignore
        }
      }
      if (!isFinished) {
        ctx.stderr.write(`Error: Run ${runId} is not finished\n`);
        return 1;
      }
    }

    const runBranch = `substrate/runs/${runId}`;
    try {
      execFileSync("git", ["merge", runBranch], {
        cwd: ctx.cwd,
        encoding: "utf8",
        stdio: "pipe",
      });
      ctx.stdout.write(`Successfully merged branch ${runBranch}\n`);
      return 0;
    } catch (err: any) {
      ctx.stderr.write(`Error merging ${runBranch}: ${err.message}\n`);
      return 1;
    }
  },
};

registry.register(mergeCommand);
