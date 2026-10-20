import { spawnSync } from "node:child_process";

export const FALLBACK_IDENTITY_NAME = "substrate";
export const FALLBACK_IDENTITY_EMAIL = "substrate@localhost";

// True when git resolves a value for `key` in this repository (any config layer).
function configured(cwd: string, key: string): boolean {
  const res = spawnSync("git", ["config", "--get", key], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return res.status === 0 && res.stdout.trim().length > 0;
}

/**
 * Environment for an engine git command that creates a commit (a merge). When git has no
 * configured user.name or user.email, the matching GIT_AUTHOR_* and GIT_COMMITTER_* variables
 * get the substrate fallback, unless the caller already set them. A configured identity is
 * never overridden, and nothing is written to any git config.
 *
 * @param cwd The repository or worktree the command runs in.
 * @param base The environment to extend (defaults to this process's environment).
 * @returns A new environment object for execFileSync.
 */
export function gitIdentityEnv(cwd: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!configured(cwd, "user.name")) {
    env.GIT_AUTHOR_NAME ??= FALLBACK_IDENTITY_NAME;
    env.GIT_COMMITTER_NAME ??= FALLBACK_IDENTITY_NAME;
  }
  if (!configured(cwd, "user.email")) {
    env.GIT_AUTHOR_EMAIL ??= FALLBACK_IDENTITY_EMAIL;
    env.GIT_COMMITTER_EMAIL ??= FALLBACK_IDENTITY_EMAIL;
  }
  return env;
}
