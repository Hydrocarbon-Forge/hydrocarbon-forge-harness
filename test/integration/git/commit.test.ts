import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import * as Contracts from "../../../src/contracts/index.js";
import { createTestRepo, type TestRepo } from "./test-repo.js";
import { gitCommitter } from "../../../src/git/commit.js";
import type { GitCommitter, GitDiffResult } from "../../../src/git/commit.js";

function getGitCommitter(): GitCommitter {
  return gitCommitter;
}

function makeSpec(overrides?: Partial<Contracts.TaskSpecFrontmatter>): Contracts.TaskSpecFrontmatter {
  return Contracts.TaskSpecFrontmatter.parse({
    id: "TaskCommit",
    title: "Commit Test",
    class: "feature",
    depends_on: [],
    read: ["README.md"],
    write: ["src/**/*.ts"],
    create: ["test/**/*.ts"],
    protected: ["src/contracts/**"],
    verify: [{ run: "echo verify ok", timeout_s: 30 }],
    ...overrides,
  });
}

describe("git: GitCommitter - commitAllowed", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-commit-test-");
    repo.commitFile("src/index.ts", "console.log('init');\n");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("stages strictly allowed paths matching write/create pathspecs and commits with author substrate-engine", async () => {
    const committer = getGitCommitter();
    const spec = makeSpec({
      write: ["src/**/*.ts"],
      create: ["test/**/*.ts"],
    });

    // Make allowed modification
    writeFileSync(join(repo.dir, "src/index.ts"), "console.log('updated');\n", "utf8");
    // Make allowed creation
    mkdirSync(join(repo.dir, "test"), { recursive: true });
    writeFileSync(join(repo.dir, "test/app.test.ts"), "it('works', () => {});\n", "utf8");
    // Also create an untracked file that does NOT match pathspecs
    writeFileSync(join(repo.dir, "untracked.log"), "debug log\n", "utf8");

    const sha = await committer.commitAllowed(repo.dir, spec, "feat(TaskCommit): implemented feature");

    expect(sha).toMatch(/^[a-f0-9]{40}$/);

    // Verify commit author
    const author = repo.git(["log", "-n", "1", "--format=%an", sha]);
    expect(author).toContain("substrate-engine");

    // Verify files in commit: should contain src/index.ts and test/app.test.ts, but NOT untracked.log
    const filesInCommit = repo.git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    expect(filesInCommit).toContain("src/index.ts");
    expect(filesInCommit).toContain("test/app.test.ts");
    expect(filesInCommit).not.toContain("untracked.log");
  });

  it("rejects commit when no changes exist in allowed pathspecs", async () => {
    const committer = getGitCommitter();
    const spec = makeSpec();

    // No changes made
    await expect(
      committer.commitAllowed(repo.dir, spec, "noop commit"),
    ).rejects.toThrow();
  });
});

describe("git: GitCommitter - generateDiff", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo("substrate-diff-test-");
    repo.commitFile("src/calc.ts", "export const add = (a: number, b: number) => a + b;\n");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("generates stat and patch against baseRef when diff is within byte cap", async () => {
    const committer = getGitCommitter();
    const baseRef = repo.git(["rev-parse", "HEAD"]);

    writeFileSync(
      join(repo.dir, "src/calc.ts"),
      "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n",
      "utf8",
    );

    const diff: GitDiffResult = await committer.generateDiff(repo.dir, baseRef);

    expect(diff.stat).toContain("src/calc.ts");
    expect(diff.patch).toContain("+export const sub");
    expect(diff.truncated).toBe(false);
  });

  it("truncates patch when exceeding maxBytes and sets truncated: true", async () => {
    const committer = getGitCommitter();
    const baseRef = repo.git(["rev-parse", "HEAD"]);

    // Generate large diff content
    let largeContent = "";
    for (let i = 0; i < 500; i++) {
      largeContent += `// Line ${i}: ${"a".repeat(80)}\n`;
    }
    writeFileSync(join(repo.dir, "src/calc.ts"), largeContent, "utf8");

    const maxBytes = 256;
    const diff: GitDiffResult = await committer.generateDiff(repo.dir, baseRef, maxBytes);

    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.patch, "utf8")).toBeLessThanOrEqual(maxBytes);
  });
});
