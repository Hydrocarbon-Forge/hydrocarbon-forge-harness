import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assertSafePath, isSafePath, matchGlob } from "../../../src/util/index.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "substrate-repo-"));
}

describe("util safe paths: repo-contained checks", () => {
  it("accepts repo-contained relative paths", () => {
    const root = makeRepo();
    expect(isSafePath(root, "src/a.ts")).toBe(true);
    expect(isSafePath(root, "a/b/c.md")).toBe(true);
    expect(isSafePath(root, ".substrate/settings.json")).toBe(true);
    expect(() => assertSafePath(root, "src/a.ts")).not.toThrow();
  });

  it("rejects absolute paths", () => {
    const root = makeRepo();
    expect(isSafePath(root, "/etc/passwd")).toBe(false);
    expect(isSafePath(root, join(root, "src/a.ts"))).toBe(false);
    expect(() => assertSafePath(root, "/etc/passwd")).toThrow();
  });

  it("rejects .. segments and escapes", () => {
    const root = makeRepo();
    for (const p of ["..", "../out", "a/../../b", "a/..", "a/../..", "./../x"]) {
      expect(isSafePath(root, p), p).toBe(false);
    }
    expect(() => assertSafePath(root, "../out")).toThrow();
  });

  it("rejects empty and null-byte paths", () => {
    const root = makeRepo();
    expect(isSafePath(root, "")).toBe(false);
    expect(isSafePath(root, "a\0b")).toBe(false);
  });

  it("rejects symlink escapes where checkable", () => {
    const root = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), "substrate-outside-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    try {
      symlinkSync(outside, join(root, "link"));
    } catch {
      // Symlinks unavailable: fall back to asserting the plain escape still rejects.
      expect(isSafePath(root, "../outside")).toBe(false);
      return;
    }
    expect(isSafePath(root, "link/secret.txt")).toBe(false);
    expect(() => assertSafePath(root, "link/secret.txt")).toThrow();
  });

  it("accepts nested safe path but rejects normalized escape", () => {
    const root = makeRepo();
    mkdirSync(join(root, "a"), { recursive: true });
    expect(isSafePath(root, "a/./b")).toBe(true);
    expect(isSafePath(root, "a/b/../../../c")).toBe(false);
  });
});

describe("util glob matching: pure picomatch semantics", () => {
  it("matches per project glob semantics without filesystem writes", () => {
    expect(matchGlob("src/**", "src/a/b.ts")).toBe(true);
    expect(matchGlob("src/**", "other/a")).toBe(false);
    expect(matchGlob("Edit(src/**)", "Edit(src/a.ts)")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a/b.ts")).toBe(false);
  });

  it("** crosses separators while * does not", () => {
    expect(matchGlob("**/*.ts", "a/b/c.ts")).toBe(true);
    expect(matchGlob("*.ts", "a/b.ts")).toBe(false);
    expect(matchGlob("a/**/c", "a/b/b/c")).toBe(true);
  });

  it("dotfiles, empty patterns and edge globs behave deterministically", () => {
    expect(matchGlob("", "anything")).toBe(false);
    expect(matchGlob("", "")).toBe(false);
    // Dotfiles require an explicit dot in the pattern under default semantics.
    expect(matchGlob("*", ".hidden")).toBe(false);
    expect(matchGlob(".*", ".hidden")).toBe(true);
    expect(matchGlob("**", "a/b/c")).toBe(true);
    // Deterministic: repeated calls agree.
    expect(matchGlob("src/**", "src/x")).toBe(matchGlob("src/**", "src/x"));
  });

  it("supports the plan §4.4 permission forms", () => {
    expect(matchGlob("Bash(git *)", "Bash(git status)")).toBe(true);
    expect(matchGlob("Bash(git *)", "Bash(npm test)")).toBe(false);
    expect(matchGlob("Edit(src/**)", "Edit(src/a/b.ts)")).toBe(true);
    expect(matchGlob("Edit(src/**)", "Edit(other/a.ts)")).toBe(false);
    expect(matchGlob("mcp__s__t", "mcp__s__t")).toBe(true);
    expect(matchGlob("mcp__s__t", "mcp__s__other")).toBe(false);
  });

  it("never throws on untrusted pattern input", () => {
    expect(() => matchGlob("[", "x")).not.toThrow();
    expect(matchGlob("[", "x")).toBe(false);
  });
});
