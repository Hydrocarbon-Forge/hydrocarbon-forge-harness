import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { TaskMerger } from "../../git/merger.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  run?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  dryRun?: boolean;
  abortOnConflict?: boolean;
  hard?: boolean;
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

export interface MergeRunOptions {
  dryRun?: boolean;
  abortOnConflict?: boolean;
}

function resolveRunBranch(repoRoot: string, runId: string): { branch: string; exists: boolean } {
  let runBranch = `substrate/runs/${runId}`;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${runBranch}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return { branch: runBranch, exists: true };
  } catch {
    const doubleRef = `refs/heads/refs/heads/${runBranch}`;
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", doubleRef], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return { branch: doubleRef, exists: true };
    } catch {}
  }
  return { branch: runBranch, exists: false };
}

function isRunFinished(repoRoot: string, runId: string): boolean {
  const eventsFile = path.join(repoRoot, ".substrate", "runs", runId, "events.jsonl");
  if (!fs.existsSync(eventsFile)) {
    return false;
  }
  try {
    const content = fs.readFileSync(eventsFile, "utf8");
    const lines = content.split("\n");
    let finishedExitCode: number | null = null;
    let finishedIndex = -1;
    let lastPausedIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "run.finished") {
          finishedExitCode = typeof ev.data?.exit_code === "number" ? ev.data.exit_code : 0;
          finishedIndex = i;
        } else if (ev.type === "run.paused") {
          lastPausedIndex = i;
        }
      } catch {
        // ignore unparseable lines
      }
    }

    if (finishedIndex === -1 || finishedExitCode !== 0) {
      return false;
    }
    if (lastPausedIndex > finishedIndex) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function mergeRun(
  ctx: CommandContext,
  runId: string,
  opts?: MergeRunOptions
): Promise<number> {
  const dryRun = opts?.dryRun ?? !!ctx.flags.dryRun;
  const abortOnConflict = opts?.abortOnConflict ?? !!ctx.flags.abortOnConflict;

  const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
  const { branch: runBranch, exists: hasBranch } = resolveRunBranch(ctx.cwd, runId);
  const dirExists = fs.existsSync(runDir);

  if (!dirExists && !hasBranch) {
    ctx.stderr.write(`Error: unknown run ${runId}\n`);
    return 2;
  }

  if (!isRunFinished(ctx.cwd, runId)) {
    ctx.stderr.write(`Error: run ${runId} did not finish successfully; not merged\n`);
    return 1;
  }

  // Refuse if user's checkout has changes to tracked files
  try {
    const statusOut = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: ctx.cwd, encoding: "utf8" }
    ).trim();
    if (statusOut.length > 0) {
      ctx.stderr.write("Error: uncommitted changes to tracked files; commit or stash first\n");
      return 1;
    }
  } catch (err: any) {
    ctx.stderr.write(`Error checking git status: ${err.message}\n`);
    return 1;
  }

  let currentBranch = "";
  try {
    currentBranch = execFileSync(
      "git",
      ["branch", "--show-current"],
      { cwd: ctx.cwd, encoding: "utf8" }
    ).trim();
  } catch {}
  if (!currentBranch) {
    currentBranch = "HEAD";
  }

  // Already up to date?
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", runBranch, "HEAD"],
      { cwd: ctx.cwd, stdio: "ignore" }
    );
    ctx.stdout.write("Already up to date.\n");
    return 0;
  } catch {}

  // Conflict preflight
  const merger = new TaskMerger();
  const pf = await merger.preflight(ctx.cwd, "HEAD", runBranch);
  if (!pf.clean) {
    if (!abortOnConflict) {
      for (const file of pf.conflictFiles ?? []) {
        ctx.stderr.write(`${file}\n`);
      }
      return 1;
    }

    try {
      execFileSync(
        "git",
        ["merge", "--no-ff", "-m", `merge run ${runId}`, runBranch],
        { cwd: ctx.cwd, encoding: "utf8", stdio: "pipe" }
      );
    } catch {
      try {
        execFileSync("git", ["merge", "--abort"], {
          cwd: ctx.cwd,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch {}
      return 1;
    }
  }

  if (dryRun) {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `HEAD..${runBranch}`],
      { cwd: ctx.cwd, encoding: "utf8" }
    ).trim();
    ctx.stdout.write(`would merge ${count} commit(s) from ${runBranch} into ${currentBranch}\n`);
    return 0;
  }

  try {
    execFileSync(
      "git",
      ["merge", "--no-ff", "-m", `merge run ${runId}`, runBranch],
      { cwd: ctx.cwd, encoding: "utf8", stdio: "pipe" }
    );
    ctx.stdout.write(`Merged ${runBranch} into ${currentBranch}\n`);
    return 0;
  } catch (err: any) {
    ctx.stderr.write(`Error merging ${runBranch}: ${err.message}\n`);
    return 1;
  }
}

const { registry } = await import(`../registry.js`);

export const mergeCommand: CliCommand = {
  name: "merge",
  description: "Merge finished run branch into current branch",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0] || ctx.flags.run;
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }
    return mergeRun(ctx, runId);
  },
};

registry.register(mergeCommand);
