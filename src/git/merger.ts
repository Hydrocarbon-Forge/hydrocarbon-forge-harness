import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command, Settings } from "../contracts/index.js";
import { VerifyRunner } from "../verify/runner.js";
import { isRegisteredWorktree, ensureGitExclude } from "./workspace.js";
import { gitIdentityEnv } from "./identity.js";

export interface PreflightResult {
  clean: boolean;
  conflictFiles: string[];
  treeSha?: string;
}

export interface TaskMerger {
  preflight(
    repoRoot: string,
    target: string,
    taskBranch: string
  ): Promise<PreflightResult>;
}

export async function createIntegrationWorktree(
  repoRoot: string,
  runId: string,
  baseSha: string
): Promise<string> {
  const worktreePath = join(repoRoot, ".substrate", "worktrees", runId, "integration");
  ensureGitExclude(repoRoot);

  if (existsSync(worktreePath)) {
    if (isRegisteredWorktree(repoRoot, worktreePath)) {
      execFileSync("git", ["checkout", "--detach", baseSha], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: "pipe",
      });
      execFileSync("git", ["reset", "--hard", baseSha], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: "pipe",
      });
      execFileSync("git", ["clean", "-fd"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: "pipe",
      });
      return worktreePath;
    }

    rmSync(worktreePath, { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch {}
  }

  mkdirSync(dirname(worktreePath), { recursive: true });
  execFileSync(
    "git",
    ["worktree", "add", "--detach", worktreePath, baseSha],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    }
  );

  return worktreePath;
}

export async function mergeInto(
  worktreePath: string,
  taskBranch: string,
  msg: string
): Promise<string> {
  execFileSync(
    "git",
    ["merge", "--no-ff", "-m", msg, taskBranch],
    {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: "pipe",
      env: gitIdentityEnv(worktreePath),
    }
  );
  return execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    {
      cwd: worktreePath,
      encoding: "utf8",
    }
  ).trim();
}

export async function advanceRunRef(
  repoRoot: string,
  runId: string,
  newSha: string,
  expectedOldSha: string
): Promise<void> {
  let ref = `refs/heads/substrate/runs/${runId}`;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    const doubleRef = `refs/heads/refs/heads/substrate/runs/${runId}`;
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", doubleRef], { cwd: repoRoot, stdio: "ignore" });
      ref = doubleRef;
    } catch {}
  }
  execFileSync(
    "git",
    ["update-ref", ref, newSha, expectedOldSha],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    }
  );
}

/** The first verify command that did not pass: its text, exit code (null when it timed out) and raw output. */
export interface VerifyFailure {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  /** stderr then stdout, each the tail VerifyRunner kept. Not redacted and not path-stripped. */
  output: string;
}

export type VerifyOutcome = { passed: true } | { passed: false; failure: VerifyFailure };

export async function verifyIn(
  worktreePath: string,
  commands: Command[],
  settings: Settings
): Promise<VerifyOutcome> {
  if (!commands || commands.length === 0) {
    return { passed: true };
  }
  const runner = new VerifyRunner();
  const results = await runner.runVerify({
    cwd: worktreePath,
    commands,
    sandbox: settings.sandbox?.enabled ?? false,
    network: "allow",
  });
  if (runner.isAllPassed(results)) {
    return { passed: true };
  }
  const failed = results.find((r) => r.exit_code !== 0 || r.timed_out) ?? results[0];
  return {
    passed: false,
    failure: {
      command: failed.cmd,
      exit_code: failed.timed_out ? null : failed.exit_code,
      timed_out: failed.timed_out,
      output: [failed.stderr_tail, failed.stdout_tail].filter((t) => t !== "").join("\n"),
    },
  };
}

export async function preflight(
  repoRoot: string,
  target: string,
  taskBranch: string
): Promise<PreflightResult> {
  try {
    const stdout = execFileSync(
      "git",
      ["merge-tree", "--write-tree", "--name-only", target, taskBranch],
      { cwd: repoRoot, encoding: "utf8" }
    );
    const treeSha = stdout.trim();
    return {
      clean: true,
      conflictFiles: [],
      treeSha,
    };
  } catch (err: any) {
    if (err.status === 1 && typeof err.stdout === "string") {
      const lines = err.stdout.split("\n");
      const treeSha = lines[0]?.trim() || undefined;
      const conflictFiles: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) break;
        conflictFiles.push(line);
      }
      return {
        clean: false,
        conflictFiles,
        treeSha,
      };
    }
    return {
      clean: false,
      conflictFiles: [err?.stderr?.trim() || err?.message || `cannot resolve ${taskBranch}`],
    };
  }
}

class TaskMergerImpl implements TaskMerger {
  preflight = preflight;
}

export const TaskMerger = TaskMergerImpl;
