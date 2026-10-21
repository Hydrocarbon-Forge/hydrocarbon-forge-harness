import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkRepairDiff, isTestPath, readRepairDiff, SKIP_MARKERS } from "../../../src/engine/repair-guard.js";

// R12.4: the anti-cheat rules of a repair attempt. A clean diff passes; each rule rejects with its reason.

const clean = { changes: [{ status: "M", path: "src/a.txt" }], added: [{ path: "src/a.txt", text: "repaired" }] };

describe("checkRepairDiff: the anti-cheat rules (R12.4)", () => {
  it("passes a clean diff that edits code", () => {
    expect(checkRepairDiff(clean)).toEqual({ ok: true });
  });

  it("(i) rejects an attempt that changed nothing", () => {
    expect(checkRepairDiff({ changes: [], added: [] })).toEqual({ ok: false, reason: "the repair changed nothing" });
  });

  it("(ii) rejects a deleted test file, and names it", () => {
    const verdict = checkRepairDiff({ changes: [{ status: "D", path: "test/a.test.ts" }], added: [] });
    expect(verdict).toEqual({ ok: false, reason: "it deletes test file test/a.test.ts" });
  });

  it("(ii) rejects a test file renamed away (by its old path), and a rename that keeps a test name", () => {
    const moved = checkRepairDiff({ changes: [{ status: "R", from: "tests/x.spec.ts", path: "src/x.ts" }], added: [] });
    expect(moved).toEqual({ ok: false, reason: "it renames away test file tests/x.spec.ts" });
    expect(checkRepairDiff({ changes: [{ status: "R", from: "src/x.ts", path: "tests/x.ts" }], added: [] })).toEqual({ ok: true });
  });

  it("(iii) rejects an added skip marker and names it and the file", () => {
    const verdict = checkRepairDiff({
      changes: [{ status: "M", path: "src/a.test.ts" }],
      added: [{ path: "src/a.test.ts", text: "  it.skip('works', () => {});" }],
    });
    expect(verdict).toEqual({ ok: false, reason: "it adds a skip marker (.skip() in src/a.test.ts" });
  });

  it("(iii) does not flag .only( or process.exit(", () => {
    const only = checkRepairDiff({
      changes: [{ status: "M", path: "src/a.test.ts" }],
      added: [{ path: "src/a.test.ts", text: "it.only('works', () => {});" }, { path: "src/a.ts", text: "process.exit(1);" }],
    });
    expect(only).toEqual({ ok: true });
  });

  it("(iii) flags each marker in the table", () => {
    const samples: Record<string, string> = {
      ".skip(": "describe.skip('x', () => {})",
      "xit(": "xit('x', () => {})",
      "xdescribe(": "xdescribe('x', () => {})",
      "it.todo": "it.todo('later')",
      "test.todo": "test.todo('later')",
      "@Ignore": "@Ignore(\"no\")",
      "@Disabled": "@Disabled",
      "pytest.mark.skip": "@pytest.mark.skip",
      "pytest.skip(": "pytest.skip('no')",
      "t.Skip(": "t.Skip(\"no\")",
      "#[ignore]": "#[ignore]",
      "skipIf": "it.skipIf(true)('x')",
      "unittest.skip": "@unittest.skip('no')",
    };
    expect(Object.keys(samples).sort()).toEqual(SKIP_MARKERS.map((m) => m.name).sort());
    for (const [name, text] of Object.entries(samples)) {
      const verdict = checkRepairDiff({ changes: [{ status: "M", path: "f.txt" }], added: [{ path: "f.txt", text }] });
      expect(verdict, name).toEqual({ ok: false, reason: `it adds a skip marker (${name}) in f.txt` });
    }
  });

  it("(iv) rejects a change under .substrate/, including a manifest there", () => {
    const verdict = checkRepairDiff({
      changes: [{ status: "M", path: ".substrate/runs/r1/manifest.yaml" }],
      added: [],
    });
    expect(verdict).toEqual({ ok: false, reason: "it changes .substrate/runs/r1/manifest.yaml under .substrate/" });
  });

  it("the first rule that fails gives the reason (the .substrate/ rule is checked before the test rule)", () => {
    const verdict = checkRepairDiff({
      changes: [{ status: "D", path: "test/a.test.ts" }, { status: "M", path: ".substrate/x" }],
      added: [],
    });
    expect(verdict).toEqual({ ok: false, reason: "it changes .substrate/x under .substrate/" });
  });
});

describe("isTestPath", () => {
  it("matches test directories and test file names", () => {
    for (const p of ["test/a.ts", "tests/a.ts", "__tests__/a.ts", "spec/a.rb", "src/a.test.ts", "src/a.spec.js", "pkg/a_test.go", "pkg/test_a.py"]) {
      expect(isTestPath(p), p).toBe(true);
    }
  });

  it("does not match source files that only look similar", () => {
    for (const p of ["src/contest.ts", "src/latest.ts", "src/testing/util.ts", "src/a.ts"]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe("readRepairDiff: the diff from git (R12.4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "substrate-r124-guard-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
    git(["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "a.test.ts"), "test('a', () => {});\n");
    writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    git(["checkout", "-q", "-b", "repair"]);
    execFileSync("git", ["rm", "-q", "test/a.test.ts"], { cwd: dir, env, stdio: "pipe" });
    writeFileSync(join(dir, "src.ts"), "export const a = 2;\n// repaired\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "repair"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the changed paths and the added lines of a repair commit", () => {
    const diff = readRepairDiff(dir, "main", "repair");
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        { status: "D", path: "test/a.test.ts" },
        { status: "M", path: "src.ts" },
      ]),
    );
    expect(diff.added).toEqual(expect.arrayContaining([{ path: "src.ts", text: "// repaired" }]));
    expect(checkRepairDiff(diff)).toEqual({ ok: false, reason: "it deletes test file test/a.test.ts" });
  });
});
