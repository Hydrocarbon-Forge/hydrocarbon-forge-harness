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
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
  run?: string;
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
    const taskId = ctx.rawArgs[0];

    if (!taskId) {
      ctx.stderr.write("Error: task id required\n");
      return 2;
    }

    const runId = ctx.flags.run;
    const worktreesBase = path.join(ctx.cwd, ".substrate", "worktrees");
    let worktreeDir: string;

    if (runId) {
      worktreeDir = path.join(worktreesBase, runId, taskId);
      if (!fs.existsSync(worktreeDir)) {
        ctx.stderr.write(`Error: no worktree for task ${taskId} in run ${runId}\n`);
        return 2;
      }
    } else {
      let found: string | undefined;
      if (fs.existsSync(worktreesBase)) {
        const runDirs = fs
          .readdirSync(worktreesBase, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
        for (const run of runDirs) {
          const candidate = path.join(worktreesBase, run, taskId);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            found = candidate;
          }
        }
      }
      if (!found) {
        ctx.stderr.write(`Error: no worktree for task ${taskId} in run unknown\n`);
        return 2;
      }
      worktreeDir = found;
    }

    const specPath = path.join(worktreeDir, ".substrate-task", "TASK.md");
    let commands = parseSpecVerifyCommands(specPath);

    if (typeof ctx.flags.timeout === "number" && ctx.flags.timeout > 0) {
      for (const c of commands) {
        c.timeout_s = ctx.flags.timeout;
      }
    }

    if (commands.length === 0) {
      ctx.stdout.write("[verify] no commands to verify\n");
      return 0;
    }

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
