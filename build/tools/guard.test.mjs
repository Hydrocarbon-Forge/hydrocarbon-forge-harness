// Offline self-test for guard.mjs (no model calls): node --test build/tools/guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, match } from "./guard.mjs";

const GUARD = fileURLToPath(new URL("./guard.mjs", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")));
fs.mkdirSync(path.join(root, "build/state/scope"), { recursive: true });
for (const wp of ["T0", "T1", "T2"]) {
  fs.mkdirSync(path.join(root, ".worktrees", wp, "ok"), { recursive: true });
  fs.writeFileSync(path.join(root, "build/state/scope", wp + ".json"), JSON.stringify({
    allow_worker: ["ok/**"], allow_test_writer: ["test/**"], deny: ["ok/frozen.txt"] }));
}
fs.symlinkSync(os.tmpdir(), path.join(root, ".worktrees/T0/ok/escape"));

const call = (agent_type, tool_name, tool_input, extra = {}) => decide({ agent_type, tool_name, tool_input, ...extra }, root);
const W = path.join(root, ".worktrees/T0");
const allowed = (r) => assert.equal(r.ok, true, r.reason);
const denied = (r, re) => { assert.equal(r.ok, false, "expected a denial"); if (re) assert.match(r.reason, re); };

test("glob matching", () => {
  assert.ok(match(["src/store/**"], "src/store/a/b.ts"));
  assert.ok(match(["**/*.ts"], "a.ts") && match(["**/*.ts"], "x/y/a.ts"));
  assert.ok(!match(["src/*.ts"], "src/a/b.ts"));
});

test("a worker writes only inside its own worktree and spec scope", () => {
  allowed(call("substrate-worker-s", "Write", { file_path: `${W}/ok/a.txt` }));
  denied(call("substrate-worker-s", "Write", { file_path: `${W}/bad/b.txt` }), /outside the spec/);
  denied(call("substrate-worker-s", "Edit", { file_path: `${W}/ok/frozen.txt` }), /protected by the spec/);
  denied(call("substrate-worker-m", "Write", { file_path: `${root}/src/x.ts` }), /own worktree/);
  denied(call("substrate-worker-l", "Write", { file_path: `${W}/.substrate-task/TASK.md` }), /read-only/);
  denied(call("substrate-worker-s", "Write", { file_path: `${W}/ok/escape/pwned.txt` }), /outside the repository/);
  denied(call("substrate-worker-s", "Write", { file_path: "/etc/passwd" }), /outside the repository/);
  denied(call("substrate-worker-s", "Write", {}), /recognizable path/);
  denied(call("substrate-worker-s", "Write", { file_path: `${root}/.worktrees/T9/ok/a.txt` }), /no scope file/);
});

test("a test-writer is limited to test paths", () => {
  allowed(call("substrate-test-writer", "Write", { file_path: `${W}/test/a.test.ts` }));
  denied(call("substrate-test-writer", "Write", { file_path: `${W}/ok/a.txt` }), /outside the spec/);
});

test("everyone else is left alone", () => {
  allowed(call(undefined, "Write", { file_path: `${root}/src/x.ts` }));
  allowed(call(undefined, "Bash", { command: "npm test && git branch -D x" }));
  allowed(call("substrate-researcher", "Bash", { command: "claude -p hi" }));
  allowed(call("substrate-spec-writer", "Write", { file_path: `${root}/build/specs/P1.1.md` }));
  allowed(call("general-purpose", "Write", { file_path: "/tmp/anything" }));
});

test("a worker is bound to one worktree and a worktree to one worker", () => {
  const as = (id, wp) => call("substrate-worker-s", "Write", { file_path: `${root}/.worktrees/${wp}/ok/a.txt` }, { agent_id: id });
  allowed(as("agentA", "T0"));
  allowed(as("agentA", "T0"));
  denied(as("agentA", "T1"), /bound to T0/);
  denied(as("agentB", "T0"), /already owned/);
  allowed(as("agentB", "T1"));
  denied(as("bad id!", "T1"), /invalid agent_id/);
  allowed(call("substrate-worker-s", "Write", { file_path: `${root}/.worktrees/T1/ok/b.txt` }));
});

test("workers cannot change git state shared with sibling worktrees", () => {
  allowed(call("substrate-worker-s", "Bash", { command: "npm test -- test/unit/util && git status && git diff --stat" }));
  allowed(call("substrate-worker-s", "Bash", { command: "git add -A && git commit -m x" }));
  for (const c of ["git worktree remove ../T1", "git -C ../T1 reset --hard", "git branch -D build/T1-g1", "git stash", "git push origin main", "git --git-dir=../T1/.git status"]) {
    denied(call("substrate-worker-m", "Bash", { command: c }), /shared between worktrees/);
  }
});

test("the script blocks with exit 2, logs only worker decisions, and never gets in the way otherwise", () => {
  const run = (payload, input = JSON.stringify(payload)) => spawnSync("node", [GUARD], { input, encoding: "utf8", env: { ...process.env, GUARD_ROOT: root } });
  const bad = run({ agent_type: "substrate-worker-s", tool_name: "Write", tool_input: { file_path: `${W}/nope/x` } });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /Blocked by Substrate guard/);
  assert.equal(run({ agent_type: "substrate-worker-s", tool_name: "Write", tool_input: { file_path: `${root}/.worktrees/T2/ok/fine.txt` }, agent_id: "agentC" }).status, 0);
  assert.equal(run({ tool_name: "Write", tool_input: { file_path: "/anywhere" } }).status, 0);
  assert.equal(run(null, "not json").status, 0);
  const log = fs.readFileSync(path.join(root, "build/state/guard.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((l) => l.ok), [false, true]);
  assert.equal(log[1].agent_id, "agentC");
});
