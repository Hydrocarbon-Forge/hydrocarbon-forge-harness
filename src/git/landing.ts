import { spawnSync } from "node:child_process";

// Git facts about where a run's work lands (R7.4). Each helper is silent on stderr and
// returns an empty or false value when the fact cannot be computed.

function gitOut(cwd: string, args: string[]): string | undefined {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return res.status === 0 ? res.stdout : undefined;
}

/** The checked-out branch of the project, or "HEAD" when detached or unknown. */
export function currentBranchName(repoRoot: string): string {
  const name = gitOut(repoRoot, ["branch", "--show-current"])?.trim();
  return name ? name : "HEAD";
}

/**
 * The files the run branch changes relative to the point where it forked from the
 * checked-out history (merge-base of HEAD and the run branch). Call it before the run is
 * merged: after the merge the fork point is the run branch itself and the list is empty.
 */
export function changedFilesOnRun(repoRoot: string, runBranch: string): string[] {
  const base = gitOut(repoRoot, ["merge-base", "HEAD", runBranch])?.trim();
  if (!base) return [];
  const names = gitOut(repoRoot, ["diff", "--name-only", "-z", base, runBranch]);
  if (names === undefined) return [];
  return names.split("\0").filter((name) => name.length > 0);
}

/** True when the run branch's tip is already in the checked-out history (the work is in the working tree). */
export function runLandedInHead(repoRoot: string, runBranch: string): boolean {
  const res = spawnSync("git", ["merge-base", "--is-ancestor", runBranch, "HEAD"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return res.status === 0;
}
