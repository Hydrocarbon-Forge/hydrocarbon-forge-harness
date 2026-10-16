import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export interface TestRepo {
  dir: string;
  git: (args: string[], options?: { env?: Record<string, string> }) => string;
  commitFile: (relPath: string, content: string, message?: string) => string;
  createBranch: (branchName: string, startPoint?: string) => void;
  cleanup: () => void;
}

export function createTestRepo(prefix = "substrate-test-"): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  function git(args: string[], options: { env?: Record<string, string> } = {}): string {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    }).trim();
  }

  git(["init", "-b", "main"]);
  git(["config", "user.name", "Substrate Test"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "commit.gpgSign", "false"]);

  function commitFile(relPath: string, content: string, message = `commit ${relPath}`): string {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
    git(["add", relPath]);
    git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  }

  function createBranch(branchName: string, startPoint = "HEAD"): void {
    git(["branch", branchName, startPoint]);
  }

  // Create initial commit
  commitFile("README.md", "# Test Repo\n", "initial commit");

  return {
    dir,
    git,
    commitFile,
    createBranch,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
