#!/usr/bin/env node
// scope.mjs — check a WP worktree's changes against its spec scope.
//   node build/tools/scope.mjs <WP> [--revert]
// Prints JSON {ok, violations[], protected_modified[], out_of_scope[]}.
// Exit 0 = clean, 1 = violations found, 2 = usage / missing worktree or spec.
// Node stdlib only. Read-only unless --revert is given; --revert restores
// tracked out-of-scope files and deletes untracked ones, never touching
// allowed files. Never commits, pushes, or uses the network.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALWAYS_DENY = [
  "build/tools/guard*.mjs",
  "build/tools/wt*.mjs",
  "build/orchestrator/**",
  ".claude/**",
  ".substrate-task/**",
];
const WP_RE = /^[A-Za-z0-9._-]+$/;

function globRe(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { i++; if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
const match = (globs, rel) => (globs || []).some((g) => globRe(g).test(rel));

const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
function listsFrom(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("spec has no frontmatter");
  const out = { write: [], create: [], protected: [] };
  let cur = null;
  for (const line of m[1].split("\n")) {
    const k = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (k) {
      cur = k[1] in out ? k[1] : null;
      const v = k[2].trim();
      if (cur && v.startsWith("[")) { out[cur] = v.slice(1, v.lastIndexOf("]")).split(",").map(unquote).filter(Boolean); cur = null; }
      continue;
    }
    const it = line.match(/^\s+-\s+(.*)$/);
    if (it && cur) out[cur].push(unquote(it[1]));
  }
  return out;
}

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Untrimmed variant: `git status --porcelain` uses a leading space as a
// significant XY column (e.g. " M file"), so trim() would corrupt it.
const gitRaw = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function fail(msg) {
  const r = { ok: false, violations: [msg], protected_modified: [], out_of_scope: [], error: msg };
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  process.stderr.write(`scope: ${msg}\n`);
  process.exit(2);
}

function unquotePath(p) {
  p = p.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try { return JSON.parse(p); } catch { return p.slice(1, -1); }
  }
  return p;
}

function parsePorcelain(out) {
  const files = [];
  for (const line of out.split("\n")) {
    if (!line || !line.trim()) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = unquotePath(p);
    if (!p) continue;
    files.push({ xy, path: p, tracked: xy !== "??" });
  }
  return files;
}

function loadTestsFile(candidates) {
  for (const f of candidates) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, "utf8"));
      if (Array.isArray(arr)) return arr.map(String);
    } catch { /* missing or unreadable: no test protection */ }
  }
  return [];
}

function main() {
  const argv = process.argv.slice(2);
  const revert = argv.includes("--revert");
  const rest = argv.filter((a) => a !== "--revert");
  if (rest.length !== 1 || !WP_RE.test(rest[0])) {
    process.stderr.write("usage: scope.mjs <WP> [--revert]\n");
    process.exit(2);
  }
  const wp = rest[0];

  let root;
  try {
    const common = git(process.cwd(), "rev-parse", "--git-common-dir");
    root = path.dirname(path.resolve(process.cwd(), common));
  } catch { fail("not inside a git repository"); }

  const wt = path.join(root, ".worktrees", wp);
  if (!fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) fail(`no worktree for ${wp}`);

  let specText = null;
  for (const f of [path.join(wt, ".substrate-task", "TASK.md"), path.join(root, "build", "specs", wp + ".md")]) {
    try { specText = fs.readFileSync(f, "utf8"); break; } catch { /* try next */ }
  }
  if (specText === null) fail(`no spec for ${wp}`);
  let lists;
  try { lists = listsFrom(specText); } catch (e) { fail(`cannot parse spec for ${wp}: ${e.message}`); }

  const allowed = [...lists.write, ...lists.create];
  const denied = [...lists.protected, ...ALWAYS_DENY];
  const prefix = `.worktrees/${wp}/`;
  const innerOf = (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

  let wtTop;
  try { wtTop = git(wt, "rev-parse", "--show-toplevel"); }
  catch { fail(`cannot inspect worktree for ${wp}`); }

  const testsDeny = new Set(loadTestsFile([
    path.join(root, "build", "state", "scope", wp + ".tests"),
    path.join(wtTop, "build", "state", "scope", wp + ".tests"),
  ]).map(innerOf));

  const byInner = (a, b) => (a.inner < b.inner ? -1 : a.inner > b.inner ? 1 : 0);
  const classify = () => {
    const out = gitRaw(wt, "status", "--porcelain=v1", "--untracked-files=all");
    const prot = [], oos = [];
    for (const f of parsePorcelain(out)) {
      const inner = innerOf(f.path);
      if (!inner || inner === ".") continue;
      if (match(denied, inner) || testsDeny.has(inner)) prot.push({ ...f, inner });
      else if (!match(allowed, inner)) oos.push({ ...f, inner });
    }
    prot.sort(byInner);
    oos.sort(byInner);
    return { prot, oos };
  };

  const mainDirty = () => gitRaw(root, "status", "--porcelain", "--untracked-files=no").trim() !== "";
  const inHead = (raw) => { try { git(wtTop, "cat-file", "-e", `HEAD:${raw}`); return true; } catch { return false; } };

  const revertFiles = (entries) => {
    for (const e of entries) {
      const abs = path.resolve(wtTop, e.path);
      try {
        if (!e.tracked) {
          fs.rmSync(abs, { recursive: true, force: true });
        } else if (inHead(e.path)) {
          try { git(wtTop, "reset", "-q", "--", e.path); } catch { /* keep going */ }
          git(wtTop, "checkout", "--", e.path);
        } else {
          try { git(wtTop, "rm", "--cached", "-q", "--", e.path); } catch { /* keep going */ }
          fs.rmSync(abs, { recursive: true, force: true });
        }
      } catch (err) {
        process.stderr.write(`scope: revert of ${e.inner} failed: ${String(err.message || err).split("\n")[0]}\n`);
      }
    }
  };

  let { prot, oos } = classify();
  const dirty = mainDirty();
  if (revert && (prot.length || oos.length)) {
    revertFiles([...prot, ...oos]);
    ({ prot, oos } = classify());
  }

  const violations = [
    ...prot.map((e) => `protected file modified: ${e.inner}`),
    ...oos.map((e) => `out of scope: ${e.inner}`),
  ];
  if (dirty) violations.push("main tree dirty");
  const result = {
    ok: violations.length === 0,
    violations,
    protected_modified: prot.map((e) => e.inner),
    out_of_scope: oos.map((e) => e.inner),
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
