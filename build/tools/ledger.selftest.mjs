#!/usr/bin/env node
// Self-test for ledger.mjs (Node stdlib only).
// Run: node build/tools/ledger.selftest.mjs
// Exercises add/summary aggregates, --phase filtering, missing-file zeros,
// unknown role/tier and non-numeric rejection (exit 2) in a throwaway git repo.
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, "ledger.mjs");

const git = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function runLedger(cwd, ...args) {
  const r = spawnSync(process.execPath, [LEDGER, ...args], { cwd, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* leave null */
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-selftest-"));
  try {
    git(tmp, "init", "-b", "main", "-q", "main");
    const root = path.join(tmp, "main");
    git(root, "config", "user.email", "ledger-test@local");
    git(root, "config", "user.name", "ledger-test");
    fs.writeFileSync(path.join(root, "init.txt"), "init\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");

    check("missing ledger file on summary prints zeros", () => {
      const r = runLedger(root, "summary");
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json, {
        subagents: 0,
        tool_uses: 0,
        tokens: 0,
        by_tier: { H: 0, S: 0, O: 0 },
        by_role: {},
      });
    });

    check("add appends one JSON line per finished subagent", () => {
      const r = runLedger(root, "add", "--role", "worker", "--tier", "H", "--phase", "B2",
        "--tool-uses", "3", "--tokens", "100");
      assert.equal(r.status, 0, r.stderr);
      const lp = path.join(root, "build", "state", "ledger.jsonl");
      assert.ok(fs.existsSync(lp));
      const lines = fs.readFileSync(lp, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const obj = JSON.parse(lines[0]);
      assert.equal(obj.role, "worker");
      assert.equal(obj.tier, "H");
      assert.equal(obj.phase, "B2");
      assert.equal(obj.tool_uses, 3);
      assert.equal(obj.tokens, 100);
      assert.ok(typeof obj.ts === "string" && obj.ts.length > 0);
      assert.ok(!("model" in obj));
    });

    check("add with --model stores model, summary aggregates by tier and role", () => {
      const r1 = runLedger(root, "add", "--role", "researcher", "--tier", "S", "--phase", "B2",
        "--tool-uses", "2", "--tokens", "50", "--model", "m1");
      assert.equal(r1.status, 0, r1.stderr);
      const r2 = runLedger(root, "add", "--role", "worker", "--tier", "O", "--phase", "B3",
        "--tool-uses", "5", "--tokens", "200");
      assert.equal(r2.status, 0, r2.stderr);
      const lp = path.join(root, "build", "state", "ledger.jsonl");
      const lines = fs.readFileSync(lp, "utf8").trim().split("\n");
      assert.equal(lines.length, 3);
      assert.equal(JSON.parse(lines[1]).model, "m1");

      const s = runLedger(root, "summary");
      assert.equal(s.status, 0, s.stderr);
      assert.equal(s.json.subagents, 3);
      assert.equal(s.json.tool_uses, 10);
      assert.equal(s.json.tokens, 350);
      assert.deepEqual(s.json.by_tier, { H: 100, S: 50, O: 200 });
      assert.deepEqual(s.json.by_role, { worker: 300, researcher: 50 });
    });

    check("summary --phase filters lines", () => {
      const s = runLedger(root, "summary", "--phase", "B2");
      assert.equal(s.status, 0, s.stderr);
      assert.equal(s.json.subagents, 2);
      assert.equal(s.json.tool_uses, 5);
      assert.equal(s.json.tokens, 150);
      assert.deepEqual(s.json.by_tier, { H: 100, S: 50, O: 0 });
      assert.deepEqual(s.json.by_role, { worker: 100, researcher: 50 });
    });

    check("summary never writes (line count unchanged)", () => {
      const lp = path.join(root, "build", "state", "ledger.jsonl");
      const before = fs.readFileSync(lp, "utf8");
      runLedger(root, "summary");
      runLedger(root, "summary", "--phase", "B2");
      assert.equal(fs.readFileSync(lp, "utf8"), before);
    });

    check("unknown role is exit 2", () => {
      const r = runLedger(root, "add", "--role", "nope", "--tier", "H", "--phase", "B2",
        "--tool-uses", "1", "--tokens", "1");
      assert.equal(r.status, 2);
    });

    check("unknown tier is exit 2", () => {
      const r = runLedger(root, "add", "--role", "worker", "--tier", "X", "--phase", "B2",
        "--tool-uses", "1", "--tokens", "1");
      assert.equal(r.status, 2);
    });

    check("non-numeric tool_uses/tokens are rejected with exit 2", () => {
      const a = runLedger(root, "add", "--role", "worker", "--tier", "H", "--phase", "B2",
        "--tool-uses", "abc", "--tokens", "1");
      assert.equal(a.status, 2);
      const b = runLedger(root, "add", "--role", "worker", "--tier", "H", "--phase", "B2",
        "--tool-uses", "1", "--tokens", "xyz");
      assert.equal(b.status, 2);
    });

    check("missing args and bad command are exit 2", () => {
      assert.equal(runLedger(root, "add", "--role", "worker").status, 2);
      assert.equal(runLedger(root, "summary", "--bogus").status, 2);
      assert.equal(runLedger(root, "bogus").status, 2);
      assert.equal(runLedger(root).status, 2);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`ledger selftest: ${passed} passed`);
}

main();
