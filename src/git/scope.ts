import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TaskSpecFrontmatter } from "../contracts/index.js";
import { matchGlob } from "../util/index.js";

export interface ScopeCheckResult {
  ok: boolean;
  violations: string[];
  protectedModified: string[];
  allowedChanges: string[];
}

export interface ScopeEnforcer {
  hashProtectedFiles(
    worktreePath: string,
    protectedGlobs: string[]
  ): Promise<Map<string, string>>;
  checkScope(
    worktreePath: string,
    spec: TaskSpecFrontmatter,
    initialHashes: Map<string, string>,
    policy: "revert" | "fail"
  ): Promise<ScopeCheckResult>;
  revertOutOfScope(
    worktreePath: string,
    violations: string[]
  ): Promise<void>;
}

function collectRelativeFiles(dir: string, base = ""): string[] {
  const result: string[] = [];
  if (!existsSync(dir)) return result;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".opencode") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectRelativeFiles(full, rel));
    } else if (entry.isFile()) {
      result.push(rel);
    }
  }
  return result;
}

function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export class ScopeEnforcerImpl implements ScopeEnforcer {
  async hashProtectedFiles(
    worktreePath: string,
    protectedGlobs: string[]
  ): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    if (!protectedGlobs || protectedGlobs.length === 0) {
      return hashes;
    }
    const allFiles = collectRelativeFiles(worktreePath);
    for (const rel of allFiles) {
      if (protectedGlobs.some((g) => matchGlob(g, rel))) {
        hashes.set(rel, sha256File(join(worktreePath, rel)));
      }
    }
    return hashes;
  }

  async checkScope(
    worktreePath: string,
    spec: TaskSpecFrontmatter,
    initialHashes: Map<string, string>,
    policy: "revert" | "fail"
  ): Promise<ScopeCheckResult> {
    const violations: string[] = [];
    const protectedModified: string[] = [];
    const allowedChanges: string[] = [];

    // Check 1: Initial protected files for modification or deletion
    for (const [relPath, origHash] of initialHashes) {
      const full = join(worktreePath, relPath);
      if (!existsSync(full)) {
        protectedModified.push(relPath);
      } else {
        const currentHash = sha256File(full);
        if (currentHash !== origHash) {
          protectedModified.push(relPath);
        }
      }
    }

    // Check 2: Newly created files matching protected globs
    if (spec.protected && spec.protected.length > 0) {
      const currentFiles = collectRelativeFiles(worktreePath);
      for (const rel of currentFiles) {
        if (
          !initialHashes.has(rel) &&
          spec.protected.some((g) => matchGlob(g, rel))
        ) {
          if (!protectedModified.includes(rel)) {
            protectedModified.push(rel);
          }
        }
      }
    }

    // Check 3: Changed or untracked paths via git status --porcelain
    const statusOut = execFileSync(
      "git",
      ["status", "--porcelain", "-uall"],
      { cwd: worktreePath, encoding: "utf8" }
    );

    const lines = statusOut.split("\n");
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
        filePath.startsWith(".substrate-task/") ||
        filePath.startsWith(".opencode/")
      ) {
        continue;
      }

      if (protectedModified.includes(filePath)) {
        continue;
      }

      const matchesWrite =
        spec.write?.some((g) => matchGlob(g, filePath)) ?? false;
      const matchesCreate =
        spec.create?.some((g) => matchGlob(g, filePath)) ?? false;

      if (!matchesWrite && !matchesCreate) {
        violations.push(filePath);
      } else {
        allowedChanges.push(filePath);
      }
    }

    if (policy === "revert" && violations.length > 0) {
      await this.revertOutOfScope(worktreePath, violations);
    }

    const ok =
      protectedModified.length === 0 &&
      (policy === "revert" || violations.length === 0);

    return {
      ok,
      violations,
      protectedModified,
      allowedChanges,
    };
  }

  async revertOutOfScope(
    worktreePath: string,
    violations: string[]
  ): Promise<void> {
    for (const file of violations) {
      const full = join(worktreePath, file);
      let tracked = false;
      try {
        execFileSync("git", ["ls-files", "--error-unmatch", "--", file], {
          cwd: worktreePath,
          stdio: "pipe",
        });
        tracked = true;
      } catch {
        tracked = false;
      }

      if (tracked) {
        try {
          execFileSync("git", ["checkout", "HEAD", "--", file], {
            cwd: worktreePath,
            stdio: "pipe",
          });
        } catch {
          // Ignore
        }
      } else {
        if (existsSync(full)) {
          rmSync(full, { recursive: true, force: true });
        }
      }
    }
  }
}

export const ScopeEnforcer = ScopeEnforcerImpl;
export const GitScopeEnforcer = ScopeEnforcerImpl;
export const scopeEnforcer = new ScopeEnforcerImpl();
