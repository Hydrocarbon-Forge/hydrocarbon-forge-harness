import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export interface E2ERepo {
  dir: string;
  git(args: string[]): string;
  cleanup(): void;
}

/**
 * Creates a clean git repository in a temp directory for E2E testing.
 *
 * @param files Files to seed the repository with
 * @returns E2ERepo handle
 */
export function createE2ERepo(files: Record<string, string> = {}): E2ERepo {
  const dir = mkdtempSync(join(tmpdir(), "substrate-e2e-"));

  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env },
    }).trim();
  }

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Substrate E2E"]);
  git(["config", "user.email", "e2e@example.com"]);
  git(["config", "commit.gpgSign", "false"]);

  const allFiles: Record<string, string> = {
    "README.md": "# E2E Test Repo\n",
    ...files,
  };

  for (const [relPath, content] of Object.entries(allFiles)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  git(["add", "-A"]);
  git(["commit", "-m", "seed"]);

  return {
    dir,
    git,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
