#!/usr/bin/env node
// Selftest for build/tools/state.mjs. Exits non-zero on the first failure.
// Runs against the enclosing git top-level, but backs up build/state/state.json
// first and restores it (or removes it) afterwards, so the worktree is untouched.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { globsOverlap, relLte, parsePlan, setWp } from "./state.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const tool = path.join(root, "build", "tools", "state.mjs");
const sp = path.join(root, "build", "state", "state.json");
const backup = fs.existsSync(sp) ? fs.readFileSync(sp, "utf8") : null;

let n = 0;
function ok(cond, name) {
  n += 1;
  if (!cond) {
    process.stderr.write(`selftest FAIL: ${name}\n`);
    restore();
    process.exit(1);
  }
  console.log(`ok ${n} ${name}`);
}
function run(...args) {
  const r = spawnSync("node", [tool, ...args], { cwd: root, encoding: "utf8" });
  return { exit: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function restore() {
  if (backup === null) {
    if (fs.existsSync(sp)) fs.rmSync(sp);
  } else {
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, backup);
  }
}

try {
  // --- unit: overlap + release ordering ---
  ok(globsOverlap("a/b", "a/b"), "equal globs overlap");
  ok(globsOverlap("src/cli/**", "src/cli"), "trailing /** stripped before prefix check");
  ok(globsOverlap("src/engine", "src/engine/reducer.ts"), "dir prefix overlaps file");
  ok(globsOverlap("src/engine/reducer.ts", "src/engine"), "overlap is symmetric");
  ok(!globsOverlap("src/a", "src/ab"), "segment boundary respected");
  ok(!globsOverlap("src/x", "src/y"), "disjoint paths do not overlap");
  ok(relLte("v0.1", "v0.1") && relLte("v0.1", "v0.2") && !relLte("v0.2", "v0.1"), "release ordering");

  // --- unit: setWp transition rules on a scratch state ---
  const mk = (status, extra = {}) => ({ wps: { W: { status, gen: 1, heals: 0, replans: 0, ...extra } } });
  let s = mk("VERIFY");
  ok(setWp(s, "W", "HEAL") === null && s.wps.W.status === "HEAL" && s.wps.W.heals === 1, "VERIFY->HEAL consumes the heal");
  ok(setWp(s, "W", "VERIFY") === null, "HEAL->VERIFY re-verifies");
  ok(setWp(s, "W", "HEAL") !== null, "second HEAL refused (cap 1)");
  s = mk("PENDING");
  ok(setWp(s, "W", "REPLAN") === null && s.wps.W.gen === 2 && s.wps.W.replans === 1, "any non-terminal->REPLAN bumps gen+replans");
  ok(setWp(s, "W", "SPEC") === null, "REPLAN->SPEC");
  ok(setWp(s, "W", "BLOCKED") === null, "any non-terminal->BLOCKED");
  ok(setWp(s, "W", "SPEC") !== null, "terminal BLOCKED refuses transitions");
  s = mk("MERGED");
  ok(setWp(s, "W", "REPLAN") !== null, "terminal MERGED refuses transitions");
  s = mk("PENDING");
  ok(setWp(s, "W", "VERIFY") !== null, "skipping the chain is refused");
  ok(setWp(s, "W", "BOGUS") !== null, "bad STATUS refused");
  ok(setWp(s, "NOPE", "SPEC") !== null, "unknown WP refused");

  // --- cli: init-from-plan on the real plan ---
  let r = run("init-from-plan", "--target", "v0.1", "--workers", "3");
  ok(r.exit === 0, `init-from-plan exits 0 (${r.err})`);
  ok(fs.existsSync(sp), "state.json written");
  const st = JSON.parse(fs.readFileSync(sp, "utf8"));
  ok(st.release_target === "v0.1" && st.max_workers === 3, "target/workers stored");
  ok(st.approved_phases && st.approved_phases.B2 === true, "B2 phase pre-approved");
  ok(st.order.length >= 40 && st.order[0] === "P0.1", "§16 order preserved");
  for (const id of ["P0.1", "P1.3", "P3.5", "P6.6"]) ok(st.wps[id], `parsed ${id}`);
  const p01 = st.wps["P0.1"];
  ok(p01.status === "PENDING" && p01.gen === 1 && p01.heals === 0 && p01.replans === 0, "fresh counters");
  ok(p01.deps.length === 0 && p01.write.includes("package.json"), "P0.1 deps/write");
  ok(p01.tier === "H" && p01.eff === "med" && p01.tf === "n" && p01.sz === "S" && p01.rel === "v0.1", "P0.1 tier/eff/tf/sz/rel");
  ok(st.wps["P1.3"].deps.join(",") === "P1.1,P1.2", "multi deps parsed");
  ok(st.wps["P1.1"].tf === "y", "TF=y parsed");
  r = run("init-from-plan");
  ok(r.exit === 1, "second init without --force refused");
  r = run("init-from-plan", "--force");
  ok(r.exit === 0, "init --force re-initializes");

  // --- cli: get / list ---
  r = run("get", "P0.1");
  ok(r.exit === 0 && JSON.parse(r.out).status === "PENDING", "get returns the WP");
  r = run("get", "NOPE");
  ok(r.exit === 1 && r.err.length > 0, "get unknown WP exits 1 with reason");
  r = run("list");
  ok(r.exit === 0 && JSON.parse(r.out).length === st.order.length, "list returns all ids in order");
  r = run("list", "PENDING");
  ok(r.exit === 0 && JSON.parse(r.out).length === st.order.length, "list filters by status");
  r = run("list", "BOGUS");
  ok(r.exit === 1, "list bad STATUS exits 1");

  // --- cli: next on a fresh state (no plan phase approved -> []) ---
  r = run("next");
  ok(r.exit === 0 && JSON.parse(r.out).length === 0, "next is [] before any phase approval");
  r = run("set", "phase:P0", "bogus");
  ok(r.exit === 1, "bad phase value refused");
  r = run("set", "phase:P0", "approved");
  ok(r.exit === 0, "phase:P0 approved");
  r = run("next");
  let nx = JSON.parse(r.out);
  ok(nx.includes("P0.1") && !nx.includes("P1.1"), "next gates on deps (P1.1 waits for P0.1)");
  ok(nx.length <= 3, "next defaults to max_workers cap");
  r = run("next", "--limit", "1");
  ok(r.exit === 0 && JSON.parse(r.out).length <= 1, "--limit caps next");
  r = run("next", "--limit", "0");
  ok(r.exit === 1, "bad --limit refused");

  // --- cli: legal chain P0.1 -> MERGED unlocks P1.1 ---
  for (const to of ["SPEC", "TESTS", "IMPL", "SCOPE", "VERIFY", "MERGED"]) {
    r = run("set", "P0.1", to);
    ok(r.exit === 0, `set P0.1 ${to}`);
  }
  r = run("set", "phase:P1", "approved");
  ok(r.exit === 0, "phase:P1 approved");
  nx = JSON.parse(run("next", "--limit", "50").out);
  ok(nx.includes("P1.1"), "MERGED dep unlocks the dependent");

  // --- cli: illegal transitions ---
  r = run("set", "P0.1", "SPEC");
  ok(r.exit === 1, "terminal MERGED refuses transitions");
  r = run("set", "P0.2", "MERGED");
  ok(r.exit === 1, "chain cannot be skipped");
  r = run("set", "P0.2", "BOGUS");
  ok(r.exit === 1, "bad STATUS exits 1");
  r = run("set", "NOPE", "SPEC");
  ok(r.exit === 1, "unknown WP exits 1");

  // --- cli: missing file -> exit 2 ---
  const tmp = fs.readFileSync(sp, "utf8");
  fs.rmSync(sp);
  r = run("get", "P0.1");
  ok(r.exit === 2, "missing state.json exits 2");
  fs.writeFileSync(sp, tmp);

  // --- parsePlan ignores non-§16 tables ---
  const fake = "## 16. x\n| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |\n|---|---|---|---|---|---|---|---|---|\n## 17. y\n| G0 | x | y |\n";
  ok(parsePlan(fake).length === 0, "header/separator/gate rows skipped");

  console.log(`selftest PASS (${n} checks)`);
  restore();
} catch (e) {
  process.stderr.write(`selftest ERROR: ${String((e && e.message) || e)}\n`);
  restore();
  process.exit(1);
}
