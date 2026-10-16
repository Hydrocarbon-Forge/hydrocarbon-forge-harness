#!/usr/bin/env node
// merge.mjs — merge listed WPs in order through wt.mjs, run the integration gate, bisect on failure.
//
//   node build/tools/merge.mjs <WP>...
//
// Merges strictly in argv order by running `node build/tools/wt.mjs merge <WP>`
// for each WP; aborts on the first merge failure (earlier merges stay).
// Then runs the integration gate in main (`npm run typecheck && npm test`),
// skipped while the repo has no `src/` directory. On gate failure it resets
// main to the pre-batch sha and re-merges one by one, running the gate after
// each; the first red merge is the culprit.
//
// Prints JSON {merged[], gate?, culprit?, ...} to stdout: `merged` lists the
// WPs still merged in main when the command exits, `gate` is one of
// "passed" | "skipped" | "failed" | "not-run", and `culprit` names the first
// red WP when bisection finds one.
// Exit 0 = all merged and gate green (or skipped); 1 = merge or gate
// failure; 2 = usage error.
// Main is always left at a green or the pre-batch sha, never red.
//
// Node stdlib only (spawnSync git/npm). Never pushes; never resets past the
// pre-batch sha.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WP_RE = /^[A-Za-z0-9._-]+$/;

function repoRoot() {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
    return path.dirname(path.resolve(process.cwd(), common));
  } catch {
    return null;
  }
}

const headSha = (root) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const hardReset = (root, sha) =>
  execFileSync("git", ["reset", "--hard", "-q", sha], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function wtMerge(root, wp) {
  return spawnSync(process.execPath, [path.join(root, "build", "tools", "wt.mjs"), "merge", wp], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runGate(root) {
  // `npm run typecheck && npm test`, first 40 lines kept on failure.
  // Install first: the merged tree may carry a package.json whose deps were
  // never installed in main (worktrees each get their own `npm ci`).
  const chunks = [];
  if (fs.existsSync(path.join(root, "package.json")) && !fs.existsSync(path.join(root, "node_modules"))) {
    const installer = fs.existsSync(path.join(root, "package-lock.json")) ? ["ci"] : ["install", "--no-audit", "--no-fund"];
    const r = spawnSync("npm", installer, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    chunks.push(`$ npm ${installer.join(" ")}\n${r.stdout || ""}${r.stderr || ""}`);
    if (r.status !== 0) {
      return { ok: false, log: chunks.join("\n").split("\n").slice(-40).join("\n") };
    }
  }
  for (const args of [["run", "typecheck"], ["test"]]) {
    const r = spawnSync("npm", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    chunks.push(`$ npm ${args.join(" ")}\n${r.stdout || ""}${r.stderr || ""}`);
    if (r.status !== 0) {
      return { ok: false, log: chunks.join("\n").split("\n").slice(-40).join("\n") };
    }
  }
  return { ok: true, log: "" };
}

const tail = (s, n) => String(s || "").split("\n").slice(-n).join("\n");
const emit = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + "\n");

function main() {
  const wps = process.argv.slice(2);
  if (wps.length === 0 || !wps.every((w) => WP_RE.test(w))) {
    process.stderr.write("usage: merge.mjs <WP>...\n");
    process.exit(2);
  }
  const root = repoRoot();
  if (!root) {
    process.stderr.write("merge: not inside a git repository\n");
    emit({ merged: [], error: "not inside a git repository" });
    process.exit(2);
  }

  const preBatch = headSha(root);
  const merged = [];
  for (const wp of wps) {
    const r = wtMerge(root, wp);
    if (r.status !== 0) {
      // Surface wt.mjs's refusal verbatim (dirty main, preflight conflict, ...).
      process.stderr.write((r.stderr || "") + (r.stdout || ""));
      emit({ merged, gate: "not-run", error: `merge of ${wp} failed` });
      process.exit(1);
    }
    merged.push(wp);
  }

  if (!fs.existsSync(path.join(root, "src"))) {
    emit({ merged, gate: "skipped" });
    process.exit(0);
  }

  const gate = runGate(root);
  if (gate.ok) {
    emit({ merged, gate: "passed" });
    process.exit(0);
  }

  // Gate red: bisect from the pre-batch sha, one merge + gate at a time.
  process.stderr.write(`merge: integration gate failed; bisecting ${wps.length} WP(s) from ${preBatch}\n`);
  process.stderr.write(tail(gate.log, 10) + "\n");
  hardReset(root, preBatch);
  let green = preBatch;
  const kept = [];
  let culprit = null;
  let detail = gate.log;
  for (const wp of wps) {
    const r = wtMerge(root, wp);
    if (r.status !== 0) {
      culprit = wp;
      detail = tail((r.stderr || "") + (r.stdout || ""), 20);
      break;
    }
    const g = runGate(root);
    if (!g.ok) {
      culprit = wp;
      detail = g.log;
      break;
    }
    green = headSha(root);
    kept.push(wp);
  }
  if (culprit === null) {
    // Flaky gate: everything passes on re-merge; main is fully merged and green.
    emit({ merged: kept, gate: "passed", note: "gate failed on the batch but passed when bisected" });
    process.exit(0);
  }
  // Leave main at the last green sha (the pre-batch sha when the culprit is
  // first) — never red. The culprit is reported, not left merged.
  hardReset(root, green);
  process.stderr.write(`merge: culprit is ${culprit}\n`);
  emit({ merged: kept, gate: "failed", culprit, log: tail(detail, 25) });
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
