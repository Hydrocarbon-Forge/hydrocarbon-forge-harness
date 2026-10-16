#!/usr/bin/env node
// Offline self-test for packet.mjs: node build/tools/packet.selftest.mjs
// Plain script, exits non-zero on the first failure. All fixtures live in
// throwaway repos under os.tmpdir(); nothing is written to the real repo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKET = fileURLToPath(new URL("./packet.mjs", import.meta.url));
const PATCH_CAP = 200 * 1024;

const SPEC = `---
id: W1
title: Widget
class: feature
depends_on: []
read: [SUBSTRATE-PLAN.md#appendix-a, src/contracts/**]
write: [src/w.js]
create: [test/w.test.js]
protected: [src/contracts/**]
verify:
  - { run: "test -f nope.txt", timeout_s: 10 }
---
## Objective
`;

function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "packet-")));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "build/specs"), { recursive: true });
  fs.mkdirSync(path.join(repo, "build/reports"), { recursive: true });
  fs.mkdirSync(path.join(repo, "build/state"), { recursive: true });
  fs.writeFileSync(path.join(repo, "build/specs/W1.md"), SPEC);
  fs.writeFileSync(path.join(repo, "build/reports/W1.verify.json"), JSON.stringify({
    wp: "W1",
    ok: false,
    results: [{ cmd: "test -f nope.txt", exit: 1, timed_out: false, tail: "boom\n" }],
  }));
  fs.writeFileSync(path.join(repo, "build/state/state.json"), JSON.stringify({
    tasks: [
      { id: "W1", generation: 3 },
      { id: "W2", depends_on: ["W1"] },
      { id: "W3", depends_on: ["W2"] },
    ],
  }));
  fs.writeFileSync(path.join(repo, "src.txt"), "one\ntwo\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  g("worktree", "add", "-q", "-b", "build/W1-g3", ".worktrees/W1", "main");
  const wt = path.join(repo, ".worktrees/W1");
  fs.writeFileSync(path.join(wt, "src.txt"), "one\nTWO\n");
  return { repo, wt, g };
}

function run(repo, ...a) {
  return spawnSync("node", [PACKET, ...a], { cwd: repo, encoding: "utf8" });
}

function packetJson(repo, name) {
  return JSON.parse(fs.readFileSync(path.join(repo, "build/packets", name), "utf8"));
}

let n = 0;
const ok = (name, fn) => {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
};

const repos = [];
try {
  // 1. Basic packet: gen defaults to state.json, contracts/dependents picked up.
  {
    const { repo } = makeRepo();
    repos.push(repo);
    const r = run(repo, "W1", "--message", "tried my best");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /build\/packets\/W1\.g3\.json/);
    const p = packetJson(repo, "W1.g3.json");
    assert.equal(p.wp, "W1");
    assert.equal(p.generation, 3);
    assert.equal(p.failure_class, "verify_failed");
    assert.deepEqual(p.related_contracts, ["SUBSTRATE-PLAN.md#appendix-a", "src/contracts/**"]);
    assert.deepEqual(p.dependents, ["W2"]);
    assert.equal(p.worker_summary, "tried my best");
    assert.equal(p.worker_summary_untrusted, true);
    assert.equal(p.verify_ok, false);
    assert.deepEqual(p.verify_output, [{ cmd: "test -f nope.txt", exit: 1, timed_out: false, tail: "boom\n" }]);
    assert.ok(p.diff.stat.includes("src.txt"), `stat should name the changed file, got: ${p.diff.stat}`);
    assert.equal(p.diff.truncated, false);
    const patch = fs.readFileSync(path.join(repo, p.diff.patch_path), "utf8");
    assert.ok(patch.includes("TWO"), "patch should contain the worktree change");
    assert.equal(p.diff.patch_path, "build/packets/W1.g3.patch");
    assert.ok(!("transcript" in p), "packet must never embed transcripts");
    ok("basic packet with state.json gen and diff", () => {});
  }

  // 2. --gen override, scope violations -> scope_violation.
  {
    const { repo } = makeRepo();
    repos.push(repo);
    const scope = path.join(repo, "scope.json");
    fs.writeFileSync(scope, JSON.stringify({ ok: false, violations: ["evil.txt"], protected_modified: [] }));
    const r = run(repo, "W1", "--gen", "2", "--scope", scope);
    assert.equal(r.status, 0, r.stderr);
    const p = packetJson(repo, "W1.g2.json");
    assert.equal(p.generation, 2);
    assert.equal(p.failure_class, "scope_violation");
    assert.deepEqual(p.scope_violations, ["evil.txt"]);
    assert.deepEqual(p.protected_modified, []);
    ok("--gen override and scope_violation", () => {});
  }

  // 3. Protected entries -> protected_modified (wins over violations).
  {
    const { repo } = makeRepo();
    repos.push(repo);
    const scope = path.join(repo, "scope.json");
    fs.writeFileSync(scope, JSON.stringify({ violations: ["evil.txt"], protected_modified: ["src/contracts/c.js"] }));
    const r = run(repo, "W1", "--scope", scope);
    assert.equal(r.status, 0, r.stderr);
    const p = packetJson(repo, "W1.g3.json");
    assert.equal(p.failure_class, "protected_modified");
    assert.deepEqual(p.protected_modified, ["src/contracts/c.js"]);
    ok("protected_modified wins", () => {});
  }

  // 4. Missing verify report -> exit 1.
  {
    const { repo } = makeRepo();
    repos.push(repo);
    const r = run(repo, "W9");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no verify report/);
    ok("missing verify report exits 1", () => {});
  }

  // 5. Usage errors -> exit 2.
  {
    const { repo } = makeRepo();
    repos.push(repo);
    assert.equal(run(repo).status, 2);
    assert.equal(run(repo, "../etc").status, 2);
    assert.equal(run(repo, "W1", "--bogus").status, 2);
    assert.equal(run(repo, "W1", "--gen").status, 2);
    assert.equal(run(repo, "W1", "--gen", "abc").status, 2);
    assert.equal(run(repo, "W1", "--gen", "0").status, 2);
    assert.equal(run(repo, "W1", "--scope", path.join(repo, "does-not-exist.json")).status, 2);
    assert.equal(run(repo, "W1", "--message").status, 2);
    assert.equal(run(repo, "W1", "extra", "--gen", "1").status, 2);
    ok("usage errors exit 2", () => {});
  }

  // 6. Worktree removed -> "worktree gone", empty patch, still exit 0.
  {
    const { repo, g } = makeRepo();
    repos.push(repo);
    g("worktree", "remove", "--force", ".worktrees/W1");
    const r = run(repo, "W1");
    assert.equal(r.status, 0, r.stderr);
    const p = packetJson(repo, "W1.g3.json");
    assert.equal(p.diff.stat, "worktree gone");
    assert.equal(p.diff.truncated, false);
    assert.equal(fs.readFileSync(path.join(repo, p.diff.patch_path), "utf8"), "");
    ok("removed worktree yields empty patch", () => {});
  }

  // 7. Oversize diff truncates from the tail at 200 KB.
  {
    const { repo, wt } = makeRepo();
    repos.push(repo);
    fs.writeFileSync(path.join(wt, "src.txt"), `head\n${"x".repeat(300 * 1024)}\n`);
    const r = run(repo, "W1");
    assert.equal(r.status, 0, r.stderr);
    const p = packetJson(repo, "W1.g3.json");
    assert.equal(p.diff.truncated, true);
    const size = fs.statSync(path.join(repo, p.diff.patch_path)).size;
    assert.ok(size <= PATCH_CAP, `patch is ${size} bytes, over the cap`);
    const patch = fs.readFileSync(path.join(repo, p.diff.patch_path), "utf8");
    assert.ok(patch.startsWith("diff --git"), "truncation keeps the head of the diff");
    ok("oversize patch truncated at 200 KB", () => {});
  }

  // 8. No state.json -> gen 1, dependents [], missing spec -> related_contracts [].
  {
    const { repo } = makeRepo();
    repos.push(repo);
    fs.rmSync(path.join(repo, "build/state/state.json"));
    fs.writeFileSync(path.join(repo, "build/reports/W2.verify.json"), JSON.stringify({
      wp: "W2", ok: false, results: [{ cmd: "false", exit: 1, timed_out: false, tail: "" }],
    }));
    const r = run(repo, "W2");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /W2\.g1\.json/);
    const p = packetJson(repo, "W2.g1.json");
    assert.equal(p.generation, 1);
    assert.deepEqual(p.dependents, []);
    assert.deepEqual(p.related_contracts, []);
    ok("gen 1 fallback without state.json or spec", () => {});
  }

  // 9. Long worker message is capped at 2000 chars.
  {
    const { repo } = makeRepo();
    repos.push(repo);
    const r = run(repo, "W1", "--message", "m".repeat(5000));
    assert.equal(r.status, 0, r.stderr);
    const p = packetJson(repo, "W1.g3.json");
    assert.equal(p.worker_summary.length, 2000);
    ok("worker message capped", () => {});
  }

  console.log(`packet selftest: ${n} checks passed`);
} finally {
  for (const repo of repos) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", ".worktrees/W1"], { cwd: repo, stdio: "ignore" });
    } catch { /* already removed */ }
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
