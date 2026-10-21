import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  RunId,
  TaskId,
  TaskSpecFrontmatter,
} from "../contracts/index.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  baseRef: string;
  taskId: TaskId;
  generation: number;
}

export function getRunBranch(runId: RunId): string {
  return `substrate/runs/${runId}`;
}

/** True when the run's branch exists in the repository; a run that failed before creating it has none (R7.9). */
export function runBranchExists(repoRoot: string, runId: RunId): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${getRunBranch(runId)}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function getTaskBranch(
  runId: RunId,
  taskId: TaskId,
  generation: number
): string {
  return `substrate/tasks/${runId}/${taskId}-g${generation}`;
}

/**
 * True when `git worktree list` registers this path as a worktree. A plain
 * directory with the same name is a crash leftover, not a worktree.
 */
export function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const candidate = line.slice("worktree ".length).trim().replace(/^"|"$/g, "");
    if (resolve(candidate) === resolve(worktreePath)) return true;
  }
  return false;
}

export interface WorkspaceManager {
  createRunBranch(
    repoRoot: string,
    runId: RunId,
    baseRef: string
  ): Promise<string>;
  createTaskWorktree(
    repoRoot: string,
    runId: RunId,
    spec: TaskSpecFrontmatter,
    generation: number,
    baseRef?: string
  ): Promise<WorktreeInfo>;
  materializeSpec(
    worktreePath: string,
    specContent: string
  ): Promise<string>;
}

export function ensureGitExclude(repoRoot: string): void {
  let excludePath = join(repoRoot, ".git", "info", "exclude");
  const gitEntry = join(repoRoot, ".git");
  if (existsSync(gitEntry)) {
    const st = statSync(gitEntry);
    if (!st.isDirectory()) {
      const content = readFileSync(gitEntry, "utf8");
      const match = content.match(/gitdir:\s*(.+)/);
      if (match) {
        const gitDir = resolve(repoRoot, match[1].trim());
        excludePath = join(gitDir, "info", "exclude");
      }
    }
  }
  mkdirSync(dirname(excludePath), { recursive: true });
  let currentExclude = "";
  if (existsSync(excludePath)) {
    currentExclude = readFileSync(excludePath, "utf8");
  }
  const linesToAdd: string[] = [];
  // The whole .substrate/ directory is the tool's own state (runs, worktrees, settings),
  // so a run never shows as untracked in the user's checkout (R8.1).
  const excluded = new Set(currentExclude.split("\n").map((line) => line.trim()));
  if (!excluded.has(".substrate/")) {
    linesToAdd.push(".substrate/");
  }
  if (!currentExclude.includes(".substrate/worktrees/")) {
    linesToAdd.push(".substrate/worktrees/");
  }
  if (!currentExclude.includes(".substrate-task/")) {
    linesToAdd.push(".substrate-task/");
  }
  if (!currentExclude.includes(".opencode/")) {
    linesToAdd.push(".opencode/");
  }
  if (linesToAdd.length > 0) {
    const sep =
      currentExclude.endsWith("\n") || currentExclude.length === 0 ? "" : "\n";
    writeFileSync(
      excludePath,
      currentExclude + sep + linesToAdd.join("\n") + "\n",
      "utf8"
    );
  }
}

export class WorkspaceManagerImpl implements WorkspaceManager {
  async createRunBranch(
    repoRoot: string,
    runId: RunId,
    baseRef: string
  ): Promise<string> {
    const branchName = getRunBranch(runId);
    try {
      const list = execFileSync("git", ["branch", "--list", branchName], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      if (!list) {
        execFileSync("git", ["branch", branchName, baseRef], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      }
    } catch (err: any) {
      throw new Error(`Failed to create run branch ${branchName}: ${err.message}`);
    }
    return branchName;
  }

  async createTaskWorktree(
    repoRoot: string,
    runId: RunId,
    spec: TaskSpecFrontmatter,
    generation: number,
    baseRef?: string
  ): Promise<WorktreeInfo> {
    const branch = getTaskBranch(runId, spec.id, generation);
    const effectiveBaseRef = baseRef ?? getRunBranch(runId);

    // Ensure exclude file registers .substrate/worktrees/ and .substrate-task/
    ensureGitExclude(repoRoot);

    const worktreePath = join(
      repoRoot,
      ".substrate",
      "worktrees",
      runId,
      `${spec.id}-g${generation}`
    );

    if (existsSync(worktreePath)) {
      if (isRegisteredWorktree(repoRoot, worktreePath)) {
        // Resume or heal: the worktree is returned as it is. It is never removed.
        return {
          worktreePath,
          branch,
          baseRef: effectiveBaseRef,
          taskId: spec.id,
          generation,
        };
      }

      // A plain directory left by a crash is not a worktree: clean it up.
      rmSync(worktreePath, { recursive: true, force: true });
      try {
        execFileSync("git", ["worktree", "prune"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch {
        // Ignore
      }
    }

    const branchExists = execFileSync("git", ["branch", "--list", branch], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    if (branchExists) {
      throw new Error(
        `Task branch ${branch} already exists and is not reused: ${worktreePath}`
      );
    }

    execFileSync(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, effectiveBaseRef],
      {
        cwd: repoRoot,
        encoding: "utf8",
      }
    );

    return {
      worktreePath,
      branch,
      baseRef: effectiveBaseRef,
      taskId: spec.id,
      generation,
    };
  }

  async materializeSpec(
    worktreePath: string,
    specContent: string
  ): Promise<string> {
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree directory does not exist: ${worktreePath}`);
    }
    const taskDir = join(worktreePath, ".substrate-task");
    mkdirSync(taskDir, { recursive: true });
    const taskPath = join(taskDir, "TASK.md");
    writeFileSync(taskPath, specContent, "utf8");
    return taskPath;
  }
}

export const workspaceManager = new WorkspaceManagerImpl();
