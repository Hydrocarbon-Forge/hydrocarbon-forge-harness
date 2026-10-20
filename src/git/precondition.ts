import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// Result of checking the project directory before a run or plan starts. Probes
// capture their own stderr, so a missing repository never prints a raw git line.
export type RepoPrecondition =
  | { ok: true; initialised: boolean }
  | { ok: false; message: string };

export const NOT_A_REPO_MESSAGE =
  "not a git repository: run git init (and commit) first, or run substrate in an empty directory";
export const NO_COMMITS_MESSAGE =
  "repository has no commits and is not empty: make an initial commit (git commit --allow-empty -m init) first";
export const HOME_REPO_MESSAGE =
  "refusing to create a git repository in your home directory: run substrate in a project directory";

const INITIAL_COMMIT_MESSAGE = "substrate: initial empty commit";

function git(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Entries in cwd other than the ones named in `ignore`. An empty result is an empty directory.
function entriesExcept(cwd: string, ignore: string[]): string[] {
  return fs.readdirSync(cwd).filter((name) => !ignore.includes(name));
}

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// Creates the empty commit the engine needs as its base (it branches the run from HEAD).
// Identity fallbacks apply to this one commit only and never touch the user's config.
function makeInitialCommit(cwd: string): boolean {
  const identity: string[] = [];
  if (git(cwd, ["config", "--get", "user.name"]).status !== 0) {
    identity.push("-c", "user.name=substrate");
  }
  if (git(cwd, ["config", "--get", "user.email"]).status !== 0) {
    identity.push("-c", "user.email=substrate@localhost");
  }
  const commit = git(cwd, [...identity, "commit", "--allow-empty", "--no-gpg-sign", "-m", INITIAL_COMMIT_MESSAGE]);
  return commit.status === 0;
}

/**
 * Ensures the project directory is a git repository with at least one commit before
 * a run starts. Inside a work tree the run proceeds as before. A missing repository is
 * initialised only when the directory is empty (a pre-existing .substrate is ignored).
 * Anything else is refused before any run state is written.
 *
 * @param cwd The project directory (the run's working directory).
 * @returns ok with whether a repository was just initialised, or the refusal message.
 */
export function ensureRepository(cwd: string): RepoPrecondition {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.error) {
    return { ok: false, message: "git is required but could not be started" };
  }

  if (inside.status === 0 && inside.stdout.trim() === "true") {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).status === 0) {
      return { ok: true, initialised: false };
    }
    // A repository with no commits: only an empty directory can get the base commit.
    const top = git(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
    if (!sameDir(top, cwd) || entriesExcept(cwd, [".git", ".substrate"]).length > 0) {
      return { ok: false, message: NO_COMMITS_MESSAGE };
    }
    if (!makeInitialCommit(cwd)) {
      return { ok: false, message: "could not create the initial commit in this repository" };
    }
    return { ok: true, initialised: true };
  }

  if (entriesExcept(cwd, [".substrate"]).length > 0) {
    return { ok: false, message: NOT_A_REPO_MESSAGE };
  }
  if (sameDir(cwd, os.homedir())) {
    return { ok: false, message: HOME_REPO_MESSAGE };
  }
  const init = git(cwd, ["init", "--quiet"]);
  if (init.status !== 0 || !makeInitialCommit(cwd)) {
    return { ok: false, message: "could not initialise a git repository in this directory" };
  }
  return { ok: true, initialised: true };
}

export const INITIALISED_NOTICE = "initialised a new git repository (empty directory)";
