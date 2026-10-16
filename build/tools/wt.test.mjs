// Offline self-test for wt.mjs: node --test build/tools/wt.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listsFrom, scopeFor } from "./wt.mjs";

const WT = fileURLToPath(new URL("./wt.mjs", import.meta.url));
const SPEC = `---
id: P1.3
title: Event store
class: feature
depends_on: [P1.1, P1.2]
read: [SUBSTRATE-PLAN.md#appendix-a, src/contracts/**]
write: []
create:
  - src/store/**
  - test/unit/store/**
protected: [src/contracts/**]
verify:
  - { run: "npm test", timeout_s: 180 }
---
## Objective
`;

test("frontmatter lists and scope derivation", () => {
  const l = listsFrom(SPEC);
  assert.deepEqual(l, { write: [], create: ["src/store/**", "test/unit/store/**"], protected: ["src/contracts/**"] });
  const tf = scopeFor(l, true);
  assert.deepEqual(tf.allow_worker, ["src/store/**"]);
  assert.deepEqual(tf.allow_test_writer, ["test/unit/store/**"]);
  assert.deepEqual(tf.deny, ["src/contracts/**"]);
  const plain = scopeFor(l, false);
  assert.deepEqual(plain.allow_worker, ["src/store/**", "test/unit/store/**"]);
  assert.deepEqual(plain.allow_test_writer, []);
});

test("worktree lifecycle in a throwaway repo", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-")));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "build/specs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "build/specs/P1.3.md"), SPEC);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  g("add", "-A"); g("commit", "-qm", "base");
  const wt = (...a) => { const r = spawnSync("node", [WT, ...a], { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

  const out = JSON.parse(wt("new", "P1.3", "--tests-first"));
  assert.ok(fs.existsSync(path.join(out.worktree, ".substrate-task/TASK.md")));
  const scope = JSON.parse(fs.readFileSync(path.join(repo, "build/state/scope/P1.3.json"), "utf8"));
  assert.deepEqual(scope.allow_test_writer, ["test/unit/store/**"]);
  assert.match(fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8"), /\.worktrees\/[\s\S]*\.substrate-task\//);
  assert.equal(g("status", "--short").includes(".worktrees"), false, "worktrees must be excluded from the main tree");

  fs.mkdirSync(path.join(out.worktree, "test/unit/store"), { recursive: true });
  fs.writeFileSync(path.join(out.worktree, "test/unit/store/a.test.ts"), "// red\n");
  const sha = wt("checkpoint", "P1.3");
  assert.equal(fs.readFileSync(path.join(repo, "build/state/scope/P1.3.base"), "utf8").trim(), sha);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, "build/state/scope/P1.3.tests"), "utf8")), ["test/unit/store/a.test.ts"]);

  wt("remove", "P1.3");
  const gen2 = JSON.parse(wt("new", "P1.3", "--gen", "2", "--tests-first"));
  assert.equal(gen2.branch, "build/P1.3-g2");
  assert.ok(fs.existsSync(path.join(gen2.worktree, "test/unit/store/a.test.ts")), "generation 2 starts from the tests checkpoint");

  const bad = spawnSync("node", [WT, "new", "../etc"], { cwd: repo, encoding: "utf8" });
  assert.equal(bad.status, 1);
});

test("verify runs only the spec's commands and honors --expect-fail", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtv-")));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "build/specs"), { recursive: true });
  const spec = (id, cmds) => `---\nid: ${id}\nwrite: []\ncreate: [x/**]\nprotected: []\nverify:\n${cmds.map((c) => `  - { run: "${c}", timeout_s: 10 }`).join("\n")}\n---\n`;
  fs.writeFileSync(path.join(repo, "build/specs/V1.md"), spec("V1", ["test -f README.md", "echo ok"]));
  fs.writeFileSync(path.join(repo, "build/specs/V2.md"), spec("V2", ["test -f README.md", "test -f nope.txt"]));
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  g("add", "-A"); g("commit", "-qm", "base");
  const run = (...a) => spawnSync("node", [WT, ...a], { cwd: repo, encoding: "utf8" });
  assert.equal(run("new", "V1").status, 0); assert.equal(run("new", "V2").status, 0);
  assert.equal(run("verify", "V1").status, 0);
  assert.equal(run("verify", "V1", "--expect-fail").status, 1, "all-pass must fail the red check");
  const v2 = run("verify", "V2");
  assert.equal(v2.status, 1); assert.match(v2.stdout, /FAIL \(exit 1\) test -f nope\.txt/);
  assert.equal(run("verify", "V2", "--expect-fail").status, 0);
  const report = JSON.parse(fs.readFileSync(path.join(repo, "build/reports/V2.verify.json"), "utf8"));
  assert.equal(report.results.length, 2);
});

test("merge brings a worktree into main, and refuses a conflict or a dirty main", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtm-")));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "build/specs"), { recursive: true });
  for (const id of ["M1", "M2"]) fs.writeFileSync(path.join(repo, `build/specs/${id}.md`), `---\nid: ${id}\nwrite: [shared.txt]\ncreate: [x/**]\nprotected: []\nverify:\n  - { run: "true", timeout_s: 5 }\n---\n`);
  fs.writeFileSync(path.join(repo, "shared.txt"), "a\nb\nc\n"); g("add", "-A"); g("commit", "-qm", "base");
  const run = (...a) => spawnSync("node", [WT, ...a], { cwd: repo, encoding: "utf8" });
  const w1 = JSON.parse(run("new", "M1").stdout).worktree, w2 = JSON.parse(run("new", "M2").stdout).worktree;
  fs.mkdirSync(path.join(w1, "x"), { recursive: true }); fs.writeFileSync(path.join(w1, "x/a.txt"), "1\n"); fs.writeFileSync(path.join(w1, "shared.txt"), "a\nONE\nc\n");
  fs.writeFileSync(path.join(w2, "shared.txt"), "a\nTWO\nc\n");
  fs.writeFileSync(path.join(repo, "shared.txt"), "dirty\n");
  assert.equal(run("merge", "M1").status, 1, "dirty main must be refused");
  g("checkout", "--", "shared.txt");
  assert.equal(run("merge", "M1").status, 0);
  assert.ok(fs.existsSync(path.join(repo, "x/a.txt")));
  const conflict = run("merge", "M2");
  assert.equal(conflict.status, 1); assert.match(conflict.stderr, /conflict/);
  assert.equal(g("status", "--porcelain", "--untracked-files=no"), "", "a refused merge must leave main untouched");
});

test("release and remove clear a worktree's claims; new installs dependencies per worktree", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-")));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "build/specs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "build/specs/C1.md"), "---\nid: C1\nwrite: []\ncreate: [x/**]\nprotected: []\nverify:\n  - { run: \"true\", timeout_s: 5 }\n---\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  execFileSync("npm", ["install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo });
  g("add", "-A"); g("commit", "-qm", "base");
  const run = (...a) => spawnSync("node", [WT, ...a], { cwd: repo, encoding: "utf8" });
  const claims = path.join(repo, "build/state/claims"); fs.mkdirSync(claims, { recursive: true });
  const seed = () => { fs.writeFileSync(path.join(claims, "C1.worker"), "agentA"); fs.writeFileSync(path.join(claims, "agent-agentA"), "C1"); fs.writeFileSync(path.join(claims, "agent-agentZ"), "C9"); };
  seed(); assert.equal(run("release", "C1").status, 0);
  assert.deepEqual(fs.readdirSync(claims).sort(), ["agent-agentZ"], "only C1's claims are cleared");
  seed(); const n = run("new", "C1"); assert.equal(n.status, 0, n.stderr);
  assert.deepEqual(fs.readdirSync(claims).sort(), ["agent-agentZ"], "new starts from a clean slate");
  seed(); assert.equal(run("remove", "C1").status, 0);
  assert.deepEqual(fs.readdirSync(claims).sort(), ["agent-agentZ"]);
});
