#!/usr/bin/env node
// Self-test for merge.mjs (Node stdlib only).
// Run: node build/tools/merge.selftest.mjs
// Builds throwaway git repos (seeded with copies of the real wt.mjs and the
// merge.mjs under test) and exercises usage errors, argv-order merges with
// the gate skipped, conflict abort (earlier merges stay), dirty-main refusal
// verbatim, gate bisect with a named culprit, single-WP culprit, and a green
// gate. Exits non-zero on the first failure.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT_SRC = path.join(HERE, "wt.mjs");
const MERGE_SRC = path.join(HERE, "merge.mjs");

const GATE_MJS = "import fs from 'node:fs';\nprocess.exit(fs.existsSync(new URL('./red.txt', import.meta.url)) ? 1 : 0);\n";
const gatePkg = () => JSON.stringify({ scripts: { typecheck: "node gate.mjs", test: "node gate.mjs" } });

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeRepo(files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "merge-selftest-")));
  git(root, "init", "-b", "main", "-q");
  git(root, "config", "user.email", "merge-test@local");
  git(root, "config", "user.name", "merge-test");
  fs.mkdirSync(path.join(root, "build", "tools"), { recursive: true });
  fs.copyFileSync(WT_SRC, path.join(root, "build", "tools", "wt.mjs"));
  fs.copyFileSync(MERGE_SRC, path.join(root, "build", "tools", "merge.mjs"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

// Create a WP worktree whose branch carries the given (uncommitted) files;
// wt.mjs merge commits them.
function mkwp(root, wp, files) {
  git(root, "worktree", "add", "-q", "-b", `build/${wp}-g1`, `.worktrees/${wp}`, "main");
  const wt = path.join(root, ".worktrees", wp);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(wt, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return wt;
}

function runMerge(root, ...args) {
  const r = spawnSync(process.execPath, [path.join(root, "build", "tools", "merge.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* leave null */
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const roots = [];
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

function cleanup() {
  for (const root of roots) {
    try {
      const wtDir = path.join(root, ".worktrees");
      if (fs.existsSync(wtDir)) {
        for (const e of fs.readdirSync(wtDir)) {
          try {
            git(root, "worktree", "remove", "--force", path.join(".worktrees", e));
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* best effort */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  try {
    check("no args exits 2", () => {
      const root = makeRepo();
      roots.push(root);
      const r = runMerge(root);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /usage/);
    });

    check("invalid WP name exits 2", () => {
      const root = makeRepo();
      roots.push(root);
      assert.equal(runMerge(root, "../evil").status, 2);
      assert.equal(runMerge(root, "OK", "bad/name").status, 2);
    });

    check("merges strictly in argv order, gate skipped without src/", () => {
      const root = makeRepo({ "base.txt": "base\n" });
      roots.push(root);
      mkwp(root, "W1", { "w1.txt": "1\n" });
      mkwp(root, "W2", { "w2.txt": "2\n" });
      const r = runMerge(root, "W2", "W1");
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(r.json.merged, ["W2", "W1"]);
      assert.equal(r.json.gate, "skipped");
      assert.ok(!("culprit" in r.json));
      assert.equal(fs.readFileSync(path.join(root, "w1.txt"), "utf8"), "1\n");
      assert.equal(fs.readFileSync(path.join(root, "w2.txt"), "utf8"), "2\n");
    });

    check("conflict aborts: earlier merges stay, exit 1", () => {
      const root = makeRepo({ "file.txt": "base\n" });
      roots.push(root);
      mkwp(root, "WA", { "file.txt": "A\n" });
      mkwp(root, "WB", { "file.txt": "B\n" });
      const pre = git(root, "rev-parse", "HEAD");
      const r = runMerge(root, "WA", "WB");
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.deepEqual(r.json.merged, ["WA"]);
      assert.ok(!("culprit" in r.json));
      assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "A\n");
      assert.notEqual(git(root, "rev-parse", "HEAD"), pre);
    });

    check("dirty main surfaces wt.mjs refusal verbatim, exit 1", () => {
      const root = makeRepo({ "file.txt": "base\n" });
      roots.push(root);
      mkwp(root, "W1", { "w1.txt": "1\n" });
      fs.appendFileSync(path.join(root, "file.txt"), "dirty\n");
      const r = runMerge(root, "W1");
      assert.equal(r.status, 1);
      assert.deepEqual(r.json.merged, []);
      assert.match(r.stderr, /uncommitted tracked changes/);
      assert.ok(!fs.existsSync(path.join(root, "w1.txt")));
    });

    check("gate failure bisects and names the culprit, main left green", () => {
      const root = makeRepo({ "package.json": gatePkg(), "gate.mjs": GATE_MJS, "src/index.js": "export const x = 1;\n" });
      roots.push(root);
      mkwp(root, "GOOD", { "good.txt": "ok\n" });
      mkwp(root, "BAD", { "red.txt": "boom\n" });
      const r = runMerge(root, "GOOD", "BAD");
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(r.json.culprit, "BAD");
      assert.equal(r.json.gate, "failed");
      assert.deepEqual(r.json.merged, ["GOOD"]);
      // Never red: culprit reset away, green merge retained, gate passes now.
      assert.ok(!fs.existsSync(path.join(root, "red.txt")));
      assert.ok(fs.existsSync(path.join(root, "good.txt")));
      const g = spawnSync("npm", ["run", "typecheck"], { cwd: root, encoding: "utf8" });
      assert.equal(g.status, 0, (g.stdout || "") + (g.stderr || ""));
    });

    check("single-WP gate failure names that WP and restores pre-batch sha", () => {
      const root = makeRepo({ "package.json": gatePkg(), "gate.mjs": GATE_MJS, "src/index.js": "export const x = 1;\n" });
      roots.push(root);
      const pre = git(root, "rev-parse", "HEAD");
      mkwp(root, "SOLO", { "red.txt": "boom\n" });
      const r = runMerge(root, "SOLO");
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(r.json.culprit, "SOLO");
      assert.deepEqual(r.json.merged, []);
      assert.equal(git(root, "rev-parse", "HEAD"), pre);
      assert.ok(!fs.existsSync(path.join(root, "red.txt")));
    });

    check("green gate merges all, exit 0", () => {
      const root = makeRepo({ "package.json": gatePkg(), "gate.mjs": GATE_MJS, "src/index.js": "export const x = 1;\n" });
      roots.push(root);
      mkwp(root, "G1", { "g1.txt": "1\n" });
      mkwp(root, "G2", { "g2.txt": "2\n" });
      const r = runMerge(root, "G1", "G2");
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(r.json.merged, ["G1", "G2"]);
      assert.equal(r.json.gate, "passed");
    });
  } finally {
    cleanup();
  }
  console.log(`merge selftest: ${passed} passed`);
}

main();
