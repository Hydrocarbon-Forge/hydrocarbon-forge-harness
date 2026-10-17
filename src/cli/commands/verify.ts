import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { Command, Effort, Engine, PermissionMode } from "../../contracts/index.js";
import { VerifyRunner } from "../../verify/runner.js";
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

function parseSpecVerifyCommands(specPath: string): Command[] {
  if (!fs.existsSync(specPath)) return [];
  try {
    const content = fs.readFileSync(specPath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return [];
    const parsed = YAML.parse(match[1]);
    if (Array.isArray(parsed.verify)) {
      return parsed.verify;
    }
  } catch {
    // ignore
  }
  return [];
}

export const verifyCommand: CliCommand = {
  name: "verify",
  description: "Run verification commands for a task in its worktree",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0];
    const taskId = ctx.rawArgs[1];

    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }

    const worktreesBase = path.join(ctx.cwd, ".substrate", "worktrees", runId);
    let worktreeDir = taskId ? path.join(worktreesBase, taskId) : "";

    if (!worktreeDir || !fs.existsSync(worktreeDir)) {
      if (fs.existsSync(worktreesBase)) {
        const dirs = fs.readdirSync(worktreesBase);
        if (dirs.length > 0) {
          worktreeDir = path.join(worktreesBase, dirs[0]);
        }
      }
    }

    if (!worktreeDir || !fs.existsSync(worktreeDir)) {
      ctx.stderr.write(
        `Error: Worktree for run ${runId} ${taskId ? taskId : ""} not found\n`,
      );
      return 1;
    }

    const specPath = path.join(worktreeDir, ".substrate-task", "TASK.md");
    const commands = parseSpecVerifyCommands(specPath);

    const runner = new VerifyRunner();
    const results = await runner.runVerify({
      cwd: worktreeDir,
      commands,
      sandbox: Boolean(ctx.flags.sandbox),
      network: "allow",
    });

    for (const r of results) {
      ctx.stdout.write(`[verify] ${r.cmd} -> exit ${r.exit_code} (${r.duration_ms}ms)\n`);
      if (r.stdout_tail) ctx.stdout.write(r.stdout_tail + "\n");
      if (r.stderr_tail) ctx.stderr.write(r.stderr_tail + "\n");
    }

    return runner.isAllPassed(results) ? 0 : 1;
  },
};

registry.register(verifyCommand);
