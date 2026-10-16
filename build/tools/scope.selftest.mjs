#!/usr/bin/env node
// Self-test for scope.mjs (Node stdlib only).
// Run: node build/tools/scope.selftest.mjs
// Builds a throwaway git repo with a real linked worktree and exercises
// clean / out-of-scope / protected / always-deny / .tests / --revert /
// main-tree-dirty / missing-worktree / usage cases.
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCOPE = path.join(HERE, "scope.mjs");
const WP = "T1scope";

const SPEC = `---\nwrite:\n  - src/allowed.txt\n  - "src/*.js"\ncreate:\n  - new/**\nprotected:\n  - src/lock.txt\nverify:\n  - { run: "true", timeout_s: 10 }\n---\n# T1scope\n`;

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function runScope(cwd, ...args) {
  const r = spawnSync(process.execPath, [SCOPE, ...args], { cwd, encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scope-selftest-"));
  try {
    git(tmp, "init", "-b", "main", "-q", "main");
    const root = path.join(tmp, "main");
    git(root, "config", "user.email", "scope-test@local");
    git(root, "config", "user.name", "scope-test");
    fs.mkdirSync(path.join(root, "build", "specs"), { recursive: true });
    fs.writeFileSync(path.join(root, "build", "specs", WP + ".md"), SPEC);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    git(root, "worktree", "add", "-q", "-b", `build/${WP}-g1`, `.worktrees/${WP}`, "main");
    const wt = path.join(root, ".worktrees", WP);

    // Primary spec path inside the worktree (committed so it is not a change).
    fs.mkdirSync(path.join(wt, ".substrate-task"), { recursive: true });
    fs.copyFileSync(path.join(root, "build", "specs", WP + ".md"), path.join(wt, ".substrate-task", "TASK.md"));
    // An allowed tracked file, committed clean.
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "allowed.txt"), "v1\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task");

    check("clean worktree exits 0 with ok:true", () => {
      const r = runScope(root, WP);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.ok, true);
      assert.deepEqual(r.json.violations, []);
      assert.deepEqual(r.json.protected_modified, []);
      assert.deepEqual(r.json.out_of_scope, []);
    });

    check("works from inside the worktree too", () => {
      const r = runScope(wt, WP);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.ok, true);
    });

    check("allowed create glob stays clean", () => {
      fs.mkdirSync(path.join(wt, "new"), { recursive: true });
      fs.writeFileSync(path.join(wt, "new", "f.txt"), "hi\n");
      const r = runScope(root, WP);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.ok, true);
    });

    check("untracked out-of-scope file is reported, exit 1", () => {
      fs.writeFileSync(path.join(wt, "other.txt"), "x\n");
      const r = runScope(root, WP);
      assert.equal(r.status, 1);
      assert.equal(r.json.ok, false);
      assert.ok(r.json.out_of_scope.includes("other.txt"), JSON.stringify(r.json));
      assert.ok(r.json.violations.some((v) => v.includes("other.txt")));
      assert.deepEqual(r.json.protected_modified, []);
    });

    check("spec protected file lands in protected_modified", () => {
      fs.writeFileSync(path.join(wt, "src", "lock.txt"), "x\n");
      const r = runScope(root, WP);
      assert.equal(r.status, 1);
      assert.ok(r.json.protected_modified.includes("src/lock.txt"), JSON.stringify(r.json));
    });

    check("always-deny wt helper pattern applies", () => {
      fs.mkdirSync(path.join(wt, "build", "tools"), { recursive: true });
      fs.writeFileSync(path.join(wt, "build", "tools", "wt-evil.mjs"), "x\n");
      const r = runScope(root, WP);
      assert.equal(r.status, 1);
      assert.ok(r.json.protected_modified.includes("build/tools/wt-evil.mjs"), JSON.stringify(r.json));
    });

    check(".tests file denies an otherwise allowed path", () => {
      fs.mkdirSync(path.join(root, "build", "state", "scope"), { recursive: true });
      fs.writeFileSync(path.join(root, "build", "state", "scope", WP + ".tests"), JSON.stringify(["src/allowed.txt"]));
      fs.writeFileSync(path.join(wt, "src", "allowed.txt"), "v2\n");
      const r = runScope(root, WP);
      assert.equal(r.status, 1);
      assert.ok(r.json.protected_modified.includes("src/allowed.txt"), JSON.stringify(r.json));
      fs.rmSync(path.join(root, "build", "state", "scope", WP + ".tests"));
      git(wt, "checkout", "--", "src/allowed.txt");
    });

    check("--revert removes out-of-scope files and restores tracked ones", () => {
      fs.writeFileSync(path.join(wt, "tracked.txt"), "orig\n");
      git(wt, "add", "tracked.txt");
      git(wt, "commit", "-qm", "tracked");
      fs.writeFileSync(path.join(wt, "tracked.txt"), "changed\n");
      const before = runScope(root, WP);
      assert.equal(before.status, 1);
      assert.ok(before.json.out_of_scope.includes("tracked.txt"), JSON.stringify(before.json));
      const r = runScope(root, WP, "--revert");
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(r.json.ok, true);
      assert.deepEqual(r.json.out_of_scope, []);
      assert.deepEqual(r.json.protected_modified, []);
      assert.equal(fs.readFileSync(path.join(wt, "tracked.txt"), "utf8"), "orig\n");
      for (const f of ["other.txt", "src/lock.txt", "build/tools/wt-evil.mjs"]) {
        assert.ok(!fs.existsSync(path.join(wt, f)), `${f} should be reverted away`);
      }
      // Allowed files are never touched by --revert.
      assert.ok(fs.existsSync(path.join(wt, "new", "f.txt")));
    });

    check("dirty main tree is a violation, exit 1", () => {
      fs.appendFileSync(path.join(root, "build", "specs", WP + ".md"), "\n");
      const r = runScope(root, WP);
      assert.equal(r.status, 1);
      assert.ok(r.json.violations.includes("main tree dirty"), JSON.stringify(r.json));
      git(root, "checkout", "--", `build/specs/${WP}.md`);
    });

    check("missing worktree is exit 2", () => {
      const r = runScope(root, "NOPE-NOPE");
      assert.equal(r.status, 2);
    });

    check("usage error is exit 2", () => {
      assert.equal(runScope(root).status, 2);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`scope selftest: ${passed} passed`);
}

main();
