import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

import * as Contracts from "../../../src/contracts/index.js";
import { createTestRepo, type TestRepo } from "./test-repo.js";
import * as ScopeModule from "../../../src/git/scope.js";
import type { ScopeEnforcer, ScopeCheckResult } from "../../../src/git/scope.js";

function getScopeEnforcer(): ScopeEnforcer {
  const mod = ScopeModule as any;
  if (mod.ScopeEnforcer) {
    if (typeof mod.ScopeEnforcer === "function") {
      try {
        return new mod.ScopeEnforcer();
      } catch {
        return mod.ScopeEnforcer;
      }
    }
    return mod.ScopeEnforcer;
  }
  if (mod.GitScopeEnforcer) {
    if (typeof mod.GitScopeEnforcer === "function") {
      try {
        return new mod.GitScopeEnforcer();
      } catch {
        return mod.GitScopeEnforcer;
      }
    }
    return mod.GitScopeEnforcer;
  }
  if (mod.scopeEnforcer) return mod.scopeEnforcer;
  return mod as ScopeEnforcer;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function makeSpec(overrides?: Partial<Contracts.TaskSpecFrontmatter>): Contracts.TaskSpecFrontmatter {
  return Contracts.TaskSpecFrontmatter.parse({
    id: "TaskScope",
    title: "Scope Enforcement Test",
    class: "feature",
    depends_on: [],
    read: ["README.md"],
    write: ["src/**/*.ts"],
    create: ["test/**/*.ts"],
    protected: ["src/contracts/**", "src/util/**"],
    verify: [{ run: "echo verify ok", timeout_s: 30 }],
    ...overrides,
  });
}

describe("git: ScopeEnforcer - protected file hashing", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-scope-test-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("computes SHA-256 for all existing files matching protected globs", async () => {
    const enforcer = getScopeEnforcer();
    repo.commitFile("src/contracts/index.ts", "export const foo = 1;\n");
    repo.commitFile("src/util/index.ts", "export const bar = 2;\n");
    repo.commitFile("src/engine/unprotected.ts", "export const baz = 3;\n");

    const hashes = await enforcer.hashProtectedFiles(repo.dir, ["src/contracts/**", "src/util/**"]);

    expect(hashes.has("src/contracts/index.ts")).toBe(true);
    expect(hashes.get("src/contracts/index.ts")).toBe(sha256("export const foo = 1;\n"));
    expect(hashes.has("src/util/index.ts")).toBe(true);
    expect(hashes.get("src/util/index.ts")).toBe(sha256("export const bar = 2;\n"));
    expect(hashes.has("src/engine/unprotected.ts")).toBe(false);
  });

  it("returns empty map when protected globs is empty", async () => {
    const enforcer = getScopeEnforcer();
    repo.commitFile("src/contracts/index.ts", "export const foo = 1;\n");

    const hashes = await enforcer.hashProtectedFiles(repo.dir, []);
    expect(hashes.size).toBe(0);
  });
});

describe("git: ScopeEnforcer - checkScope and policies", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-scope-chk-");
    repo.commitFile("src/contracts/index.ts", "export const contract = 'v1';\n");
    repo.commitFile("src/feature/worker.ts", "export const oldWorker = true;\n");
    repo.commitFile("docs/notes.md", "# Notes\n");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("passes cleanly when changes are strictly within write and create globs", async () => {
    const enforcer = getScopeEnforcer();
    const spec = makeSpec({
      write: ["src/feature/**"],
      create: ["test/unit/**"],
      protected: ["src/contracts/**"],
    });

    const initialHashes = await enforcer.hashProtectedFiles(repo.dir, spec.protected);

    // Allowed modification to write glob
    writeFileSync(join(repo.dir, "src/feature/worker.ts"), "export const newWorker = true;\n", "utf8");
    // Allowed creation matching create glob
    repo.commitFile("test/unit/worker.test.ts", "test('worker');\n");

    const result = await enforcer.checkScope(repo.dir, spec, initialHashes, "fail");

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.protectedModified).toHaveLength(0);
    expect(result.allowedChanges).toContain("src/feature/worker.ts");
  });

  it("detects out-of-scope modifications and file creation with policy 'fail'", async () => {
    const enforcer = getScopeEnforcer();
    const spec = makeSpec({
      write: ["src/feature/**"],
      create: ["test/unit/**"],
      protected: ["src/contracts/**"],
    });

    const initialHashes = await enforcer.hashProtectedFiles(repo.dir, spec.protected);

    // Violation 1: modified tracked file outside write glob
    writeFileSync(join(repo.dir, "docs/notes.md"), "# Modified Out of Scope\n", "utf8");
    // Violation 2: created untracked file outside create glob
    writeFileSync(join(repo.dir, "malicious.sh"), "echo bad\n", "utf8");

    const result = await enforcer.checkScope(repo.dir, spec, initialHashes, "fail");

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("docs/notes.md");
    expect(result.violations).toContain("malicious.sh");
    expect(result.protectedModified).toHaveLength(0);

    // Files are retained under policy: "fail"
    expect(existsSync(join(repo.dir, "malicious.sh"))).toBe(true);
    expect(readFileSync(join(repo.dir, "docs/notes.md"), "utf8")).toBe("# Modified Out of Scope\n");
  });

  it("reverts out-of-scope files with policy 'revert', preserving allowed changes", async () => {
    const enforcer = getScopeEnforcer();
    const spec = makeSpec({
      write: ["src/feature/**"],
      create: ["test/unit/**"],
      protected: ["src/contracts/**"],
    });

    const initialHashes = await enforcer.hashProtectedFiles(repo.dir, spec.protected);

    // Allowed change
    writeFileSync(join(repo.dir, "src/feature/worker.ts"), "export const updated = true;\n", "utf8");
    // Out-of-scope tracked modification
    writeFileSync(join(repo.dir, "docs/notes.md"), "# Corrupted\n", "utf8");
    // Out-of-scope untracked creation
    writeFileSync(join(repo.dir, "untracked-rogue.txt"), "rogue content\n", "utf8");

    const result = await enforcer.checkScope(repo.dir, spec, initialHashes, "revert");

    expect(result.ok).toBe(true);
    expect(result.violations).toContain("docs/notes.md");
    expect(result.violations).toContain("untracked-rogue.txt");

    // Out-of-scope untracked file unlinked
    expect(existsSync(join(repo.dir, "untracked-rogue.txt"))).toBe(false);
    // Out-of-scope tracked file reverted to git HEAD
    expect(readFileSync(join(repo.dir, "docs/notes.md"), "utf8")).toBe("# Notes\n");
    // Allowed change kept intact
    expect(readFileSync(join(repo.dir, "src/feature/worker.ts"), "utf8")).toBe("export const updated = true;\n");
  });

  it("detects protected file alteration as protectedModified, never auto-reverting (fatal)", async () => {
    const enforcer = getScopeEnforcer();
    const spec = makeSpec({
      write: ["src/feature/**", "src/contracts/**"], // Even if worker claims write access
      create: ["test/**"],
      protected: ["src/contracts/**"],
    });

    const initialHashes = await enforcer.hashProtectedFiles(repo.dir, spec.protected);

    // Modify protected file
    writeFileSync(join(repo.dir, "src/contracts/index.ts"), "export const corrupted = true;\n", "utf8");

    // Even under policy: "revert", protected changes must fail!
    const result = await enforcer.checkScope(repo.dir, spec, initialHashes, "revert");

    expect(result.ok).toBe(false);
    expect(result.protectedModified).toContain("src/contracts/index.ts");
  });

  it("detects protected file created when initially absent as protectedModified", async () => {
    const enforcer = getScopeEnforcer();
    const spec = makeSpec({
      write: ["src/**"],
      create: ["src/contracts/**"],
      protected: ["src/contracts/**"],
    });

    const initialHashes = await enforcer.hashProtectedFiles(repo.dir, spec.protected);

    // Create a new file matching protected pattern that was absent before
    writeFileSync(join(repo.dir, "src/contracts/unauthorized.ts"), "export const hack = 1;\n", "utf8");

    const result = await enforcer.checkScope(repo.dir, spec, initialHashes, "fail");

    expect(result.ok).toBe(false);
    expect(result.protectedModified).toContain("src/contracts/unauthorized.ts");
  });

  it("detects protected file deletion as protectedModified", async () => {
    const enforcer = getScopeEnforcer();
    const spec = makeSpec({
      write: ["src/**"],
      create: ["test/**"],
      protected: ["src/contracts/**"],
    });

    const initialHashes = await enforcer.hashProtectedFiles(repo.dir, spec.protected);

    // Delete protected file
    unlinkSync(join(repo.dir, "src/contracts/index.ts"));

    const result = await enforcer.checkScope(repo.dir, spec, initialHashes, "fail");

    expect(result.ok).toBe(false);
    expect(result.protectedModified).toContain("src/contracts/index.ts");
  });
});

describe("git: ScopeEnforcer - revertOutOfScope", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-rev-test-");
    repo.commitFile("tracked.txt", "initial tracked\n");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("reverts tracked changes and unlinks untracked files in violations list", async () => {
    const enforcer = getScopeEnforcer();

    writeFileSync(join(repo.dir, "tracked.txt"), "modified tracked\n", "utf8");
    writeFileSync(join(repo.dir, "untracked.txt"), "new untracked\n", "utf8");

    await enforcer.revertOutOfScope(repo.dir, ["tracked.txt", "untracked.txt"]);

    expect(existsSync(join(repo.dir, "untracked.txt"))).toBe(false);
    expect(readFileSync(join(repo.dir, "tracked.txt"), "utf8")).toBe("initial tracked\n");
  });
});
