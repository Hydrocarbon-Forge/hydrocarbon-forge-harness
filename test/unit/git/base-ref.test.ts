import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveBaseRef } from "../../../src/git/base-ref.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "R75 Unit",
  GIT_AUTHOR_EMAIL: "r75@example.com",
  GIT_COMMITTER_NAME: "R75 Unit",
  GIT_COMMITTER_EMAIL: "r75@example.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}

describe("resolveBaseRef", () => {
  let dir: string;
  let first: string;
  let head: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "substrate-r75-unit-"));
    git(dir, ["init", "-q", "-b", "master"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "first"]);
    first = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "a.txt"), "two\n");
    git(dir, ["commit", "-q", "-am", "second"]);
    head = git(dir, ["rev-parse", "HEAD"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an absent base_ref uses the run base and prints no note", () => {
    expect(resolveBaseRef(dir, undefined)).toEqual({ sha: head });
    expect(resolveBaseRef(dir, "")).toEqual({ sha: head });
  });

  it("(none) uses the run base and prints no note", () => {
    expect(resolveBaseRef(dir, "(none)")).toEqual({ sha: head });
  });

  it("the current branch's name uses the run base and prints no note", () => {
    expect(resolveBaseRef(dir, "master")).toEqual({ sha: head });
    expect(resolveBaseRef(dir, "HEAD")).toEqual({ sha: head });
    expect(resolveBaseRef(dir, head)).toEqual({ sha: head });
  });

  it("main in a master repository does not resolve: the run base is used and the note names it", () => {
    expect(resolveBaseRef(dir, "main")).toEqual({
      sha: head,
      note: `planner base_ref 'main' ignored; using run base ${head.slice(0, 7)}`,
    });
  });

  it("a name for the run base's commit under another name: the run base is used and the note says so", () => {
    git(dir, ["branch", "alias", "HEAD"]);
    expect(resolveBaseRef(dir, "alias")).toEqual({
      sha: head,
      note: `planner base_ref 'alias' ignored; using run base ${head.slice(0, 7)}`,
    });
  });

  it("a name for a different valid commit is used as the base, with no note", () => {
    git(dir, ["branch", "older", first]);
    expect(resolveBaseRef(dir, "older")).toEqual({ sha: first });
  });

  it("a ref that starts with a dash never resolves and is ignored with a note", () => {
    expect(resolveBaseRef(dir, "--all")).toEqual({
      sha: head,
      note: `planner base_ref '--all' ignored; using run base ${head.slice(0, 7)}`,
    });
  });

  it("a repository with no commit has no run base and throws a plain message", () => {
    const empty = mkdtempSync(join(tmpdir(), "substrate-r75-empty-"));
    try {
      git(empty, ["init", "-q", "-b", "master"]);
      expect(() => resolveBaseRef(empty, "main")).toThrow(/HEAD does not point at a commit/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
