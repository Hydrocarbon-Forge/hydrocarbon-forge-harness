import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { nowIsoTimestamp } from "../../util/index.js";

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
  noGovernor?: boolean;
  force?: boolean;
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

function isPidAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
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

const { registry } = await import(`../registry.js`);

export const discardCommand: CliCommand = {
  name: "discard",
  description: "Remove run worktrees and delete run branch",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0] || ctx.flags.run;
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }

    const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
    const { branch: runBranch, exists: hasBranch } = resolveRunBranch(ctx.cwd, runId);
    const dirExists = fs.existsSync(runDir);

    if (!dirExists && !hasBranch) {
      ctx.stderr.write(`Error: unknown run ${runId}\n`);
      return 2;
    }

    // Check lock
    const lockPath = path.join(ctx.cwd, ".substrate", "state", `${runId}.lock`);
    if (fs.existsSync(lockPath)) {
      let pid: number | undefined;
      try {
        const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        pid = typeof data.pid === "number" ? data.pid : undefined;
      } catch {}

      if (pid !== undefined && isPidAlive(pid)) {
        const livePid = pid;
        if (!ctx.flags.force) {
          ctx.stderr.write(`Error: run ${runId} is active; pass --force to stop it\n`);
          return 1;
        }

        try {
          process.kill(livePid, "SIGTERM");
        } catch {}

        const start = Date.now();
        while (Date.now() - start < 5000) {
          if (!isPidAlive(livePid)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    }

    // Remove worktrees under .substrate/worktrees/<runId>/
    try {
      const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: ctx.cwd,
        encoding: "utf8",
      });
      const expectedPrefix = path.resolve(ctx.cwd, ".substrate", "worktrees", runId) + path.sep;
      for (const line of wtList.split("\n")) {
        if (line.startsWith("worktree ")) {
          const wtPath = line.slice(9).trim();
          const resolved = path.resolve(wtPath);
          if (resolved.startsWith(expectedPrefix)) {
            try {
              execFileSync("git", ["worktree", "remove", "--force", wtPath], {
                cwd: ctx.cwd,
                stdio: "ignore",
              });
            } catch {}
          }
        }
      }
    } catch {}

    const worktreesDir = path.join(ctx.cwd, ".substrate", "worktrees", runId);
    if (fs.existsSync(worktreesDir)) {
      try {
        fs.rmSync(worktreesDir, { recursive: true, force: true });
      } catch {}
    }

    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: ctx.cwd,
        stdio: "ignore",
      });
    } catch {}

    // Delete task branches and run branch
    try {
      const branchOut = execFileSync("git", ["branch", "--list", `substrate/tasks/${runId}/*`], {
        cwd: ctx.cwd,
        encoding: "utf8",
      });
      for (const line of branchOut.split("\n")) {
        const b = line.replace(/^\*?\s+/, "").trim();
        if (b) {
          try {
            execFileSync("git", ["branch", "-D", b], { cwd: ctx.cwd, stdio: "ignore" });
          } catch {}
        }
      }
    } catch {}

    try {
      execFileSync("git", ["branch", "-D", `substrate/runs/${runId}`], {
        cwd: ctx.cwd,
        stdio: "ignore",
      });
    } catch {}
    try {
      execFileSync("git", ["branch", "-D", `refs/heads/substrate/runs/${runId}`], {
        cwd: ctx.cwd,
        stdio: "ignore",
      });
    } catch {}

    // Append run.paused event if not already terminal
    const eventsFile = path.join(ctx.cwd, ".substrate", "runs", runId, "events.jsonl");
    if (fs.existsSync(eventsFile)) {
      try {
        const content = fs.readFileSync(eventsFile, "utf8");
        const lines = content.split("\n");
        let isTerminal = false;
        let maxSeq = 0;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed);
            if (typeof ev.seq === "number" && ev.seq > maxSeq) {
              maxSeq = ev.seq;
            }
            if (ev.type === "run.finished" || ev.type === "run.paused") {
              isTerminal = true;
            }
          } catch {}
        }

        if (!isTerminal) {
          const cancelEvent = {
            v: 1,
            seq: maxSeq + 1,
            ts: nowIsoTimestamp(),
            run_id: runId,
            type: "run.paused",
            data: {
              reason: "user_cancel",
            },
          };
          fs.appendFileSync(eventsFile, JSON.stringify(cancelEvent) + "\n", "utf8");
        }
      } catch {}
    }

    ctx.stdout.write(`Discarded run ${runId}\n`);
    return 0;
  },
};

registry.register(discardCommand);
