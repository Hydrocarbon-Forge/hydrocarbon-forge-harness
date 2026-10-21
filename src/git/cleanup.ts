import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunId } from "../contracts/index.js";
import { getRunBranch } from "./workspace.js";

/** Directory names of the work a run leaves in `.substrate/worktrees/<run>/`: `<task>-g<n>` or `integration`. */
export interface RunWorkspaceSweep {
  /** Worktree directories removed, by name. */
  removedWorktrees: string[];
  /** Task branches deleted, by full ref name. */
  removedBranches: string[];
  /** Work directories whose changes were saved as evidence before removal, by name. */
  savedEvidence: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function registeredWorktrees(repoRoot: string): string[] {
  return git(repoRoot, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/**
 * Saves what a work directory changed, so a discarded task keeps its evidence under the
 * run directory. The committed part is the task branch against the run branch; the
 * uncommitted part is the worktree against its HEAD. The file is written only when no
 * patch of that name exists yet (the failure packet writes one of its own).
 */
function saveEvidence(
  repoRoot: string,
  worktreePath: string,
  runId: RunId,
  name: string,
  packetsDir: string,
  taskBranch: string | undefined,
): boolean {
  const patchPath = join(packetsDir, `${name}.patch`);
  if (existsSync(patchPath)) return false;
  mkdirSync(packetsDir, { recursive: true });
  const parts: string[] = [];
  if (taskBranch && gitOk(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch}`])) {
    parts.push(git(repoRoot, ["diff", "--binary", `${getRunBranch(runId)}...${taskBranch}`]));
  }
  if (existsSync(worktreePath)) {
    parts.push(git(worktreePath, ["diff", "--binary", "HEAD"]));
  }
  writeFileSync(patchPath, parts.filter((p) => p.length > 0).join("\n"), "utf8");
  return true;
}

/**
 * Removes every worktree and task branch a finished run left behind. The run branch is
 * kept: it holds the commits of the tasks that merged into it. Work directories named in
 * `unmerged` are saved as evidence before they are removed; `unmerged` maps a directory
 * name (`<task>-g<n>`) to its task branch.
 *
 * @param repoRoot the user's repository
 * @param runId the run whose workspaces are removed
 * @param runDir the run directory, where unmerged evidence is written under `packets/`
 * @param unmerged work directory names of tasks that did not merge, with their task branch
 * @returns what was removed and saved
 */
export function sweepRunWorkspaces(
  repoRoot: string,
  runId: RunId,
  runDir: string,
  unmerged: Map<string, string | undefined>,
): RunWorkspaceSweep {
  const result: RunWorkspaceSweep = { removedWorktrees: [], removedBranches: [], savedEvidence: [] };
  const runWorktreeDir = join(repoRoot, ".substrate", "worktrees", runId);
  const registered = new Set(registeredWorktrees(repoRoot));

  if (existsSync(runWorktreeDir)) {
    for (const name of readdirSync(runWorktreeDir).sort()) {
      const worktreePath = join(runWorktreeDir, name);
      const taskBranch = unmerged.get(name);
      if (unmerged.has(name) && saveEvidence(repoRoot, worktreePath, runId, name, join(runDir, "packets"), taskBranch)) {
        result.savedEvidence.push(name);
      }
      if (registered.has(worktreePath)) {
        if (!gitOk(repoRoot, ["worktree", "remove", "--force", worktreePath])) {
          rmSync(worktreePath, { recursive: true, force: true });
        }
      } else {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      result.removedWorktrees.push(name);
    }
    gitOk(repoRoot, ["worktree", "prune"]);
    rmSync(runWorktreeDir, { recursive: true, force: true });
    const parent = join(repoRoot, ".substrate", "worktrees");
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmdirSync(parent);
    }
  }

  const prefix = `refs/heads/substrate/tasks/${runId}/`;
  const refs = git(repoRoot, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean);
  for (const ref of refs) {
    if (gitOk(repoRoot, ["update-ref", "-d", ref])) {
      result.removedBranches.push(ref.slice("refs/heads/".length));
    }
  }
  return result;
}

/**
 * True when the task's branch exists, restoring it first when it does not: a finished run
 * removes task branches (R8.1), but the run branch keeps the commits of every task that
 * merged. The branch is rebuilt at the task's head from the `merge: task <id>` commit that
 * carries it. No worktree is created here. Returns false when the work is nowhere to be
 * found, so the caller runs the task again.
 */
export function restoreTaskBranch(
  repoRoot: string,
  runId: RunId,
  taskId: string,
  generation: number,
): boolean {
  const branch = `substrate/tasks/${runId}/${taskId}-g${generation}`;
  if (gitOk(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) return true;
  const log = gitOk(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${getRunBranch(runId)}`])
    ? git(repoRoot, ["log", "--format=%H %P%x09%s", getRunBranch(runId)])
    : "";
  for (const line of log.split("\n")) {
    const [head, subject] = line.split("\t");
    if (subject !== `merge: task ${taskId}`) continue;
    const parents = head.split(" ").slice(1);
    if (parents.length !== 2) continue;
    git(repoRoot, ["branch", branch, parents[1]]);
    return true;
  }
  return false;
}
