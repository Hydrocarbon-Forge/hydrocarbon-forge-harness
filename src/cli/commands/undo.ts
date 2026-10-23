import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { advanceRunRef } from "../../git/merger.js";

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
  hard?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
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

function findMostRecentRunIdWithCheckpoint(repoRoot: string): string | undefined {
  const runsDir = path.join(repoRoot, ".substrate", "runs");
  if (!fs.existsSync(runsDir)) return undefined;

  const entries = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dirPath = path.join(runsDir, d.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(dirPath).mtimeMs;
      } catch {}
      return { name: d.name, mtime, dirPath };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of entries) {
    const eventsFile = path.join(entry.dirPath, "events.jsonl");
    if (fs.existsSync(eventsFile)) {
      try {
        const content = fs.readFileSync(eventsFile, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed);
            if (ev.type === "batch.merged" && ev.data?.checkpoint_ref) {
              return entry.name;
            }
          } catch {}
        }
      } catch {}
    }
  }
  return undefined;
}

const { registry } = await import(`../registry.js`);

export const undoCommand: CliCommand = {
  name: "undo",
  description: "Revert run branch to prior batch checkpoint ref",
  async execute(ctx: CommandContext): Promise<number> {
    let runId = ctx.rawArgs[0] || ctx.flags.run;
    if (!runId) {
      runId = findMostRecentRunIdWithCheckpoint(ctx.cwd);
    }

    if (!runId) {
      ctx.stderr.write("Error: no checkpoint recorded for run\n");
      return 1;
    }

    const { branch: runBranch, exists: hasBranch } = resolveRunBranch(ctx.cwd, runId);
    if (!hasBranch) {
      ctx.stderr.write(`Error: unknown run ${runId}\n`);
      return 2;
    }

    const eventsFile = path.join(ctx.cwd, ".substrate", "runs", runId, "events.jsonl");
    if (!fs.existsSync(eventsFile)) {
      ctx.stderr.write(`Error: no checkpoint recorded for run ${runId}\n`);
      return 1;
    }

    let currentRunSha = "";
    try {
      currentRunSha = execFileSync(
        "git",
        ["rev-parse", runBranch],
        { cwd: ctx.cwd, encoding: "utf8" }
      ).trim();
    } catch {
      ctx.stderr.write(`Error: unknown run ${runId}\n`);
      return 2;
    }

    const content = fs.readFileSync(eventsFile, "utf8");
    const lines = content.split("\n");
    const checkpointRefs: string[] = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "batch.merged" && ev.data?.checkpoint_ref) {
          checkpointRefs.push(ev.data.checkpoint_ref);
        }
      } catch {}
    }

    if (checkpointRefs.length === 0) {
      ctx.stderr.write(`Error: no checkpoint recorded for run ${runId}\n`);
      return 1;
    }

    let targetSha: string | null = null;
    for (const ref of checkpointRefs) {
      try {
        const sha = execFileSync("git", ["rev-parse", ref], {
          cwd: ctx.cwd,
          encoding: "utf8",
        }).trim();
        if (sha !== currentRunSha) {
          targetSha = sha;
          break;
        }
      } catch {}
    }

    if (!targetSha) {
      ctx.stderr.write(`Error: no checkpoint recorded for run ${runId}\n`);
      return 1;
    }

    let currentCheckoutBranch = "";
    try {
      currentCheckoutBranch = execFileSync(
        "git",
        ["branch", "--show-current"],
        { cwd: ctx.cwd, encoding: "utf8" }
      ).trim();
    } catch {}

    if (
      currentCheckoutBranch === `substrate/runs/${runId}` ||
      currentCheckoutBranch === runBranch ||
      currentCheckoutBranch === `refs/heads/substrate/runs/${runId}`
    ) {
      ctx.stderr.write("Error: cannot undo while checkout is on run branch\n");
      return 1;
    }

    await advanceRunRef(ctx.cwd, runId, targetSha, currentRunSha);

    if (ctx.flags.hard) {
      const intWorktree = path.join(ctx.cwd, ".substrate", "worktrees", runId, "integration");
      if (fs.existsSync(intWorktree)) {
        try {
          execFileSync("git", ["reset", "--hard", targetSha], {
            cwd: intWorktree,
            encoding: "utf8",
            stdio: "pipe",
          });
        } catch {}
      }
    }

    ctx.stdout.write(`Reverted substrate/runs/${runId} to ${targetSha}\n`);
    return 0;
  },
};

registry.register(undoCommand);
