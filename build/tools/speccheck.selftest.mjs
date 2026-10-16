#!/usr/bin/env node
// Self-test for speccheck.mjs (Node stdlib only).
// Run: node build/tools/speccheck.selftest.mjs
// Builds throwaway dirs with build/specs/<WP>.md fixtures and exercises
// valid / missing / empty / malformed-frontmatter / missing-field /
// id-mismatch / verify / headings / paths / globs / fences / usage cases.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "speccheck.mjs");

const HEADS = ["Objective", "Interface", "Behavior", "Invariants", "Edge cases", "Guardrails", "Out of scope"];
const headBody = (heads) => `${heads.map((h) => `## ${h}\nSome text.\n`).join("\n")}`;
const GOOD_FM = (over = {}) => {
  const fm = {
    id: "WPspeccheck",
    title: "Some tool",
    class: "bootstrap",
    depends_on: [],
    read: ["SUBSTRATE-PLAN.md"],
    write: [],
    create: ["build/tools/speccheck.mjs"],
    protected: ["build/tools/guard.mjs"],
    ...over,
  };
  const fmt = (v) => (Array.isArray(v) ? `[${v.map((s) => `"${s}"`).join(", ")}]` : v);
  const keys = ["id", "title", "class", "depends_on", "read", "write", "create", "protected"];
  const lines = keys.filter((k) => k in fm).map((k) => `${k}: ${fmt(fm[k])}`);
  if ("verify" in fm) {
    if (fm.verify === "EMPTY") {
      lines.push("verify: []");
    } else if (typeof fm.verify === "string") {
      lines.push(`verify: ${fm.verify}`);
    } else {
      lines.push("verify:");
      for (const e of fm.verify) lines.push(`  - { run: "${e.run}", timeout_s: ${e.timeout_s} }`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
};
const GOOD = () => `${GOOD_FM({ verify: [{ run: "node build/tools/speccheck.selftest.mjs", timeout_s: 60 }] })}${headBody(HEADS)}`;

function runCheck(cwd, ...args) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "speccheck-selftest-"));
  try {
    const root = path.join(tmp, "repo");
    const specs = path.join(root, "build", "specs");
    fs.mkdirSync(specs, { recursive: true });
    const put = (wp, text) => fs.writeFileSync(path.join(specs, `${wp}.md`), text);

    check("valid spec exits 0 with SPEC OK", () => {
      put("WPspeccheck", GOOD());
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /SPEC OK/);
    });

    check("exactly 12 fence lines is valid, 13 is not", () => {
      const fence = (n) => `${GOOD()}\n\`\`\`text\n${"x\n".repeat(n)}\`\`\`\n`;
      put("WPspeccheck", fence(12));
      assert.equal(runCheck(root, "WPspeccheck").status, 0);
      put("WPspeccheck", fence(13));
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /fences:/);
      put("WPspeccheck", GOOD());
    });

    check("missing spec is exit 2", () => {
      const r = runCheck(root, "NOPE-NOPE");
      assert.equal(r.status, 2);
      assert.match(r.stdout, /SPEC MISSING/);
    });

    check("empty file is exit 1 with errors", () => {
      put("WPempty", "");
      const r = runCheck(root, "WPempty");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /SPEC INVALID/);
    });

    check("malformed frontmatter is an error, never a crash", () => {
      put("WPbadfm", `---\nverify: [unclosed\n${headBody(HEADS)}`);
      const r = runCheck(root, "WPbadfm");
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stdout, /frontmatter:/);
      put("WPbadfm", `no frontmatter here\n${headBody(HEADS)}`);
      const r2 = runCheck(root, "WPbadfm");
      assert.equal(r2.status, 1);
      assert.match(r2.stdout, /frontmatter:/);
    });

    check("missing required field is reported", () => {
      const fm = GOOD_FM({ verify: [{ run: "x", timeout_s: 1 }] }).replace(/^protected:.*\n/m, "");
      put("WPspeccheck", `${fm}${headBody(HEADS)}`);
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /missing required field 'protected'/);
      put("WPspeccheck", GOOD());
    });

    check("id mismatch is reported", () => {
      put("WPspeccheck", GOOD().replace('id: WPspeccheck', 'id: OTHER'));
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /does not match filename/);
      put("WPspeccheck", GOOD());
    });

    check("verify must be non-empty with run and timeout_s", () => {
      put("WPspeccheck", `${GOOD_FM({ verify: "EMPTY" })}${headBody(HEADS)}`);
      assert.match(runCheck(root, "WPspeccheck").stdout, /'verify' must be a non-empty list/);
      put("WPspeccheck", `${GOOD_FM({ verify: "oops" })}${headBody(HEADS)}`);
      assert.equal(runCheck(root, "WPspeccheck").status, 1);
      put("WPspeccheck", `---\nid: "WPspeccheck"\ntitle: "t"\nclass: "c"\ndepends_on: []\nread: []\nwrite: []\ncreate: []\nprotected: []\nverify:\n  - { run: "x" }\n---\n${headBody(HEADS)}`);
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /missing numeric 'timeout_s'/);
      put("WPspeccheck", GOOD());
    });

    check("missing headings are reported", () => {
      put("WPspeccheck", `${GOOD_FM({ verify: [{ run: "x", timeout_s: 1 }] })}${headBody(HEADS.filter((h) => h !== "Invariants"))}`);
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /missing heading 'Invariants'/);
      put("WPspeccheck", GOOD());
    });

    check("absolute paths, .. segments and bad globs are reported", () => {
      put("WPspeccheck", `${GOOD_FM({ verify: [{ run: "x", timeout_s: 1 }], write: ["/abs/path"], read: ["a/../b"] })}${headBody(HEADS)}`);
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /is absolute/);
      assert.match(r.stdout, /contains '\.\.'/);
      put("WPspeccheck", `${GOOD_FM({ verify: [{ run: "x", timeout_s: 1 }], create: ["src/[abc].js"] })}${headBody(HEADS)}`);
      const r2 = runCheck(root, "WPspeccheck");
      assert.equal(r2.status, 1);
      assert.match(r2.stdout, /glob characters/);
      put("WPspeccheck", GOOD());
    });

    check("every error is reported, not just the first", () => {
      put("WPspeccheck", `${GOOD_FM({ verify: [{ run: "x", timeout_s: 1 }], write: ["/abs"] })}${headBody(["Objective"])}`);
      const r = runCheck(root, "WPspeccheck");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /is absolute/);
      assert.match(r.stdout, /missing heading 'Interface'/);
      assert.match(r.stdout, /missing heading 'Behavior'/);
      put("WPspeccheck", GOOD());
    });

    check("spec is found from a subdirectory and left untouched", () => {
      const sub = path.join(root, "sub", "dir");
      fs.mkdirSync(sub, { recursive: true });
      put("WPspeccheck", GOOD());
      const before = fs.readFileSync(path.join(specs, "WPspeccheck.md"), "utf8");
      const r = runCheck(sub, "WPspeccheck");
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const after = fs.readFileSync(path.join(specs, "WPspeccheck.md"), "utf8");
      assert.equal(after, before);
    });

    check("usage error is exit 2", () => {
      assert.equal(runCheck(root).status, 2);
      assert.equal(runCheck(root, "a", "b").status, 2);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`speccheck selftest: ${passed} passed`);
}

main();
