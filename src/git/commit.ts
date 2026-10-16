import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskSpecFrontmatter } from "../contracts/index.js";
import { capBytes, matchGlob } from "../util/index.js";

export interface GitDiffResult {
  stat: string;
  patch: string;
  truncated: boolean;
}

export interface GitCommitter {
  commitAllowed(
    worktreePath: string,
    spec: TaskSpecFrontmatter,
    message: string
  ): Promise<string>;
  generateDiff(
    worktreePath: string,
    baseRef: string,
    maxBytes?: number
  ): Promise<GitDiffResult>;
}

export class GitCommitterImpl implements GitCommitter {
  async commitAllowed(
    worktreePath: string,
    spec: TaskSpecFrontmatter,
    message: string
  ): Promise<string> {
    const statusOut = execFileSync(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: worktreePath, encoding: "utf8" }
    );

    const lines = statusOut.split("\n");
    const filesToStage: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      let filePath = line.slice(3).trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1].trim();
      }
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      filePath = filePath.replace(/\\/g, "/");

      if (
        filePath === ".git" ||
        filePath.startsWith(".substrate/") ||
        filePath.startsWith(".substrate-task/")
      ) {
        continue;
      }

      if (spec.protected?.some((g) => matchGlob(g, filePath))) {
        continue;
      }

      const matchesWrite =
        spec.write?.some((g) => matchGlob(g, filePath)) ?? false;
      const matchesCreate =
        spec.create?.some((g) => matchGlob(g, filePath)) ?? false;

      if (matchesWrite || matchesCreate) {
        filesToStage.push(filePath);
      }
    }

    if (filesToStage.length === 0) {
      throw new Error("No changes in allowed pathspecs to commit");
    }

    for (const file of filesToStage) {
      const full = join(worktreePath, file);
      if (existsSync(full)) {
        execFileSync("git", ["add", "--", file], {
          cwd: worktreePath,
        });
      } else {
        execFileSync("git", ["rm", "--ignore-unmatch", "--", file], {
          cwd: worktreePath,
        });
      }
    }

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();

    if (!staged) {
      throw new Error("No staged changes to commit");
    }

    execFileSync("git", ["commit", "-m", message], {
      cwd: worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "substrate-engine",
        GIT_AUTHOR_EMAIL: "substrate-engine@local",
        GIT_COMMITTER_NAME: "substrate-engine",
        GIT_COMMITTER_EMAIL: "substrate-engine@local",
      },
    });

    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();

    return sha;
  }

  async generateDiff(
    worktreePath: string,
    baseRef: string,
    maxBytes?: number
  ): Promise<GitDiffResult> {
    const stat = execFileSync("git", ["diff", "--stat", baseRef], {
      cwd: worktreePath,
      encoding: "utf8",
    });

    const rawPatch = execFileSync("git", ["diff", baseRef], {
      cwd: worktreePath,
      encoding: "utf8",
    });

    let patch = rawPatch;
    let truncated = false;

    if (maxBytes !== undefined && Buffer.byteLength(patch, "utf8") > maxBytes) {
      const capped = capBytes(patch, maxBytes);
      patch = capped.text;
      truncated = true;
    }

    return {
      stat,
      patch,
      truncated,
    };
  }
}

export const GitCommitter = GitCommitterImpl;
export const gitCommitter = new GitCommitterImpl();
