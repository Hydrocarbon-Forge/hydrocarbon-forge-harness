import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { changedFilesOnRun, currentBranchName, runLandedInHead } from "../../../src/git/landing.js";

// R7.4: the git facts behind the landing block. Each helper is silent and degrades to an
// empty or false value when a fact cannot be computed.

const IDENTITY = {
  GIT_AUTHOR_NAME: "R74 Test",
  GIT_AUTHOR_EMAIL: "r74@example.com",
  GIT_COMMITTER_NAME: "R74 Test",
  GIT_COMMITTER_EMAIL: "r74@example.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
}

describe("R7.4 git landing helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "substrate-r74-landing-"));
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "a.txt"), "seed\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "seed"]);
    git(dir, ["checkout", "-q", "-b", "substrate/runs/r_TEST"]);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.txt"), "new\n");
    writeFileSync(join(dir, "a.txt"), "seed\nchanged\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "run work"]);
    git(dir, ["checkout", "-q", "main"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every file the run branch changes against the checked-out history, sorted by git", () => {
    expect(changedFilesOnRun(dir, "substrate/runs/r_TEST")).toEqual(["a.txt", "src/b.txt"]);
  });

  it("is empty when the run branch does not exist, and silent about it", () => {
    expect(changedFilesOnRun(dir, "substrate/runs/missing")).toEqual([]);
  });

  it("reports the run as not landed until it is merged into the checked-out branch", () => {
    expect(runLandedInHead(dir, "substrate/runs/r_TEST")).toBe(false);
    git(dir, ["merge", "--no-ff", "-q", "-m", "merge run", "substrate/runs/r_TEST"]);
    expect(runLandedInHead(dir, "substrate/runs/r_TEST")).toBe(true);
  });

  it("names the checked-out branch, and HEAD when detached", () => {
    expect(currentBranchName(dir)).toBe("main");
    git(dir, ["checkout", "-q", "--detach"]);
    expect(currentBranchName(dir)).toBe("HEAD");
  });
});
