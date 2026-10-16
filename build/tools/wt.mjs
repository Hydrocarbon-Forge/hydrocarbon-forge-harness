#!/usr/bin/env node
// Bootstrap worktree helper (hand-written, read-only; the guard's per-WP scope files come from here).
//   node build/tools/wt.mjs new <WP> [--tests-first] [--gen N]   worktree + branch + .substrate-task/TASK.md + scope file
//   node build/tools/wt.mjs commit <WP> <message>                commit everything in the WP worktree (the engine commits, workers never do)
//   node build/tools/wt.mjs checkpoint <WP>                      commit tests and remember that commit as the base for later generations
//   node build/tools/wt.mjs merge <WP>                           commit, preflight with git merge-tree, then merge --no-ff into main (main must be clean)
//   node build/tools/wt.mjs release <WP>                          clear the worker claims on a worktree (use when its worker is gone)
//   node build/tools/wt.mjs remove <WP>                          delete the worktree (the branch is kept)
//   node build/tools/wt.mjs verify <WP> [--expect-fail]          run ONLY the verify commands listed in build/specs/<WP>.md, inside the worktree;
//                                                                writes build/reports/<WP>.verify.json; exit 0 = all passed (or, with --expect-fail, at least one failed)
// Base branch: $WT_BASE or main. Scope file: build/state/scope/<WP>.json = {allow_worker, allow_test_writer, deny}.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const testLike = (g) => /(^|\/)(test|tests|__tests__)\//.test(g) || /\.(test|spec)\./.test(g);
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

export function listsFrom(text) { // the subset of the TaskSpec frontmatter the guard needs
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

export function scopeFor(lists, testsFirst) {
  const wr = [...lists.write, ...lists.create];
  const tests = wr.filter(testLike);
  return {
    allow_worker: testsFirst ? wr.filter((g) => !testLike(g)) : wr,
    allow_test_writer: testsFirst ? tests : [],
    deny: [...lists.protected],
  };
}

function clearClaims(root, wp) { // worker<->worktree bindings written by guard.mjs
  const dir = path.join(root, "build/state/claims");
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    if (f.startsWith(wp + ".") || (f.startsWith("agent-") && fs.readFileSync(file, "utf8").trim() === wp)) fs.rmSync(file);
  }
}

function main() {
  const [cmd, wp, ...rest] = process.argv.slice(2);
  const die = (m) => { process.stderr.write(`wt: ${m}\n`); process.exit(1); };
  if (!cmd || !wp || !/^[A-Za-z0-9._-]+$/.test(wp)) die("usage: wt.mjs new|commit|checkpoint|remove <WP> ...");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const wt = path.join(root, ".worktrees", wp);
  const scopeDir = path.join(root, "build/state/scope");
  const baseFile = path.join(scopeDir, wp + ".base");
  const commit = (msg) => {
    git(wt, "add", "-A");
    git(wt, "-c", "user.name=substrate-build", "-c", "user.email=build@substrate.local", "commit", "-q", "--allow-empty", "-m", msg);
    return git(wt, "rev-parse", "HEAD");
  };
  try {
    if (cmd === "new") {
      const spec = path.join(root, "build/specs", wp + ".md");
      if (!fs.existsSync(spec)) die(`no spec at build/specs/${wp}.md`);
      if (fs.existsSync(wt)) die(`worktree exists; run: wt.mjs remove ${wp}`);
      const gi = rest.indexOf("--gen");
      const gen = gi >= 0 ? Number(rest[gi + 1]) : 1;
      const testsFirst = rest.includes("--tests-first");
      const base = fs.existsSync(baseFile) ? fs.readFileSync(baseFile, "utf8").trim() : process.env.WT_BASE || "main";
      const branch = `build/${wp}-g${gen}`;
      clearClaims(root, wp);
      git(root, "worktree", "add", "-q", "-b", branch, wt, base);
      if (fs.existsSync(path.join(wt, "package-lock.json"))) { // every worktree gets its own install: nothing is shared between workers
        const r = spawnSync("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: wt, encoding: "utf8" });
        if (r.status !== 0) die("npm ci failed in the new worktree:\n" + ((r.stdout || "") + (r.stderr || "")).split("\n").slice(-15).join("\n"));
      }
      const exclude = path.resolve(root, git(root, "rev-parse", "--git-common-dir"), "info/exclude");
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const have = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
      for (const l of [".worktrees/", ".substrate-task/"]) if (!have.includes(l)) fs.appendFileSync(exclude, (have.endsWith("\n") || !have ? "" : "\n") + l + "\n");
      fs.mkdirSync(path.join(wt, ".substrate-task"), { recursive: true });
      fs.copyFileSync(spec, path.join(wt, ".substrate-task/TASK.md"));
      const scope = scopeFor(listsFrom(fs.readFileSync(spec, "utf8")), testsFirst);
      fs.mkdirSync(scopeDir, { recursive: true });
      fs.writeFileSync(path.join(scopeDir, wp + ".json"), JSON.stringify(scope, null, 2));
      console.log(JSON.stringify({ worktree: wt, branch, base, task: path.join(wt, ".substrate-task/TASK.md"), scope }));
    } else if (cmd === "commit") {
      console.log(commit(rest.join(" ") || `build(${wp})`));
    } else if (cmd === "checkpoint") {
      const sha = commit(`tests(${wp})`);
      fs.mkdirSync(scopeDir, { recursive: true });
      fs.writeFileSync(baseFile, sha + "\n");
      fs.writeFileSync(path.join(scopeDir, wp + ".tests"), JSON.stringify(git(wt, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").filter(Boolean)));
      console.log(sha);
    } else if (cmd === "verify") {
      const spec = fs.readFileSync(path.join(root, "build/specs", wp + ".md"), "utf8");
      const fm = (spec.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
      const cmds = [...fm.matchAll(/run:\s*"((?:[^"\\]|\\.)*)"(?:[^}\n]*?timeout_s:\s*(\d+))?/g)]
        .map((m) => ({ cmd: m[1].replace(/\\"/g, '"'), timeout: Number(m[2] || 120) }));
      if (!cmds.length) die("spec has no verify commands");
      if (!fs.existsSync(wt)) die(`no worktree for ${wp}`);
      const results = cmds.map(({ cmd, timeout }) => {
        const r = spawnSync("sh", ["-c", cmd], { cwd: wt, encoding: "utf8", timeout: timeout * 1000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
        const out = ((r.stdout || "") + (r.stderr || "")).split("\n");
        return { cmd, exit: r.status, timed_out: r.error?.code === "ETIMEDOUT", tail: out.slice(-40).join("\n") };
      });
      const allPass = results.every((r) => r.exit === 0);
      const expectFail = rest.includes("--expect-fail");
      const ok = expectFail ? !allPass : allPass;
      fs.mkdirSync(path.join(root, "build/reports"), { recursive: true });
      fs.writeFileSync(path.join(root, "build/reports", wp + ".verify.json"), JSON.stringify({ wp, ok, expect_fail: expectFail, results }, null, 2));
      for (const r of results) console.log(`${r.exit === 0 ? "PASS" : "FAIL"} (exit ${r.exit}${r.timed_out ? ", timed out" : ""}) ${r.cmd}`);
      if (!allPass) console.log("--- tail of the first failing command ---\n" + results.find((r) => r.exit !== 0).tail.split("\n").slice(-25).join("\n"));
      console.log(ok ? "VERIFY OK" : expectFail ? "VERIFY FAILED: expected at least one failure but everything passed" : "VERIFY FAILED");
      process.exit(ok ? 0 : 1);
    } else if (cmd === "merge") {
      const base = process.env.WT_BASE || "main";
      const branch = git(wt, "rev-parse", "--abbrev-ref", "HEAD");
      commit(`build(${wp})`);
      if (git(root, "rev-parse", "--abbrev-ref", "HEAD") !== base) die(`the main tree must be on ${base}`);
      if (git(root, "status", "--porcelain", "--untracked-files=no")) die("the main tree has uncommitted tracked changes");
      try { git(root, "merge-tree", "--write-tree", base, branch); }
      catch (e) { die("merge preflight found a conflict:\n" + String(e.stdout || e.message).trim()); }
      git(root, "-c", "user.name=substrate-build", "-c", "user.email=build@substrate.local", "merge", "--no-ff", "-q", "-m", `merge ${branch}`, branch);
      console.log(git(root, "rev-parse", "HEAD"));
    } else if (cmd === "release") {
      clearClaims(root, wp);
      console.log("released " + wp);
    } else if (cmd === "remove") {
      clearClaims(root, wp);
      git(root, "worktree", "remove", "--force", wt);
      console.log("removed " + wp);
    } else die(`unknown command ${cmd}`);
  } catch (e) { die(String(e.stderr || e.message).trim()); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
