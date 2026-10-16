#!/usr/bin/env node
// Bootstrap tool state.mjs — WP statuses, retry counters and release scope in build/state/state.json.
// Pure Node, stdlib only. No git writes, no network.
//   node build/tools/state.mjs init-from-plan [--plan P] [--target R] [--workers N] [--force]
//   node build/tools/state.mjs get <WP>
//   node build/tools/state.mjs set <WP> <STATUS>
//   node build/tools/state.mjs set phase:<N> approved
//   node build/tools/state.mjs list [STATUS]
//   node build/tools/state.mjs next [--limit K]
// Exit: 0 ok · 1 illegal transition/usage (stderr reason) · 2 missing file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATUSES = ["PENDING", "SPEC", "TESTS", "IMPL", "SCOPE", "VERIFY", "HEAL", "MERGED", "REPLAN", "BLOCKED"];
const TERMINAL = new Set(["MERGED", "BLOCKED"]);
// Linear bootstrap chain; HEAL/REPLAN/BLOCKED branch off it (see setWp).
const NEXT_OK = { PENDING: ["SPEC"], SPEC: ["TESTS"], TESTS: ["IMPL"], IMPL: ["SCOPE"], SCOPE: ["VERIFY"], VERIFY: ["MERGED"], HEAL: ["VERIFY"], REPLAN: ["SPEC"] };

export function rootDir() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}
export function statePath(root) {
  return path.join(root, "build", "state", "state.json");
}
export function loadState(root) {
  const p = statePath(root);
  if (!fs.existsSync(p)) {
    const e = new Error(`no state file at build/state/state.json (run init-from-plan first)`);
    e.code = "MISSING";
    throw e;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
export function saveState(root, st) {
  fs.mkdirSync(path.dirname(statePath(root)), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(st, null, 2) + "\n");
}

// --- §16 table parsing -------------------------------------------------------
export function parsePlan(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+16\./.test(l));
  const end = lines.findIndex((l, i) => i > start && /^##\s+17\./.test(l));
  const body = lines.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
  const wps = [];
  for (const line of body) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 9) continue;
    const id = cells[0].replace(/\*\*/g, "");
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id) || id === "ID") continue;
    if (/^-+$/.test(id)) continue;
    const [title, depsRaw, writeRaw, , tierEffRaw, tfRaw, szRaw, relRaw] = cells.slice(1);
    const deps = /^[—–-]?$/.test(depsRaw.trim()) || !depsRaw.trim()
      ? []
      : depsRaw.split(",").map((d) => d.trim()).filter(Boolean);
    const write = [...writeRaw.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
    const te = tierEffRaw.match(/([HSO])\s*\/\s*([a-z]+)/i);
    const rel = (relRaw.match(/v\d+\.\d+/) || [relRaw.trim()])[0];
    wps.push({
      id,
      title: title.replace(/\*\*/g, "").trim(),
      deps,
      write,
      rel,
      tier: te ? te[1].toUpperCase() : "",
      eff: te ? te[2].toLowerCase() : "",
      tf: (tfRaw.trim().toLowerCase().startsWith("y") ? "y" : "n"),
      sz: (szRaw.trim().toUpperCase().match(/^[SML]/) || [""])[0],
      phase: id.includes(".") ? id.slice(0, id.indexOf(".")) : id,
      status: "PENDING",
      gen: 1,
      heals: 0,
      replans: 0,
    });
  }
  return wps;
}

// --- release / overlap helpers ----------------------------------------------
export function parseRel(r) {
  const m = /^v(\d+)\.(\d+)$/.exec(String(r || "").trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export function relLte(a, b) {
  const pa = parseRel(a), pb = parseRel(b);
  if (!pa || !pb) return String(a) === String(b);
  return pa[0] < pb[0] || (pa[0] === pb[0] && pa[1] <= pb[1]);
}
export function stripGlob(g) {
  return g.endsWith("/**") ? g.slice(0, -3) : g;
}
export function globsOverlap(a, b) {
  if (a === b) return true;
  const sa = stripGlob(a), sb = stripGlob(b);
  if (sa === sb) return true;
  return sa.startsWith(sb + "/") || sb.startsWith(sa + "/");
}
export function writesOverlap(wa, wb) {
  for (const a of wa) for (const b of wb) if (globsOverlap(a, b)) return true;
  return false;
}

// --- transitions --------------------------------------------------------------
export function setWp(st, id, status) {
  const wp = st.wps[id];
  if (!wp) return `unknown WP ${id}`;
  status = String(status || "").toUpperCase();
  if (!STATUSES.includes(status) || status === "PENDING") return `bad STATUS ${status}`;
  if (TERMINAL.has(wp.status)) return `${id} is terminal (${wp.status})`;
  if (status === "HEAL") {
    if (wp.status !== "VERIFY") return `${id} cannot go ${wp.status}→HEAL (needs VERIFY)`;
    if (!(wp.heals < 1)) return `${id} has no heals left`;
    wp.heals += 1;
    wp.status = "HEAL";
    return null;
  }
  if (status === "REPLAN") {
    if (!(wp.replans < 2)) return `${id} has no replans left`;
    wp.replans += 1;
    wp.gen += 1;
    wp.status = "REPLAN";
    return null;
  }
  if (status === "BLOCKED") {
    wp.status = "BLOCKED";
    return null;
  }
  const ok = NEXT_OK[wp.status] || [];
  if (!ok.includes(status)) return `${id} cannot go ${wp.status}→${status}`;
  wp.status = status;
  return null;
}

export function eligibleNext(st, limit) {
  const cap = limit ?? st.max_workers;
  const out = [];
  for (const id of st.order) {
    const wp = st.wps[id];
    if (!wp || wp.status !== "PENDING") continue;
    if (!relLte(wp.rel, st.release_target)) continue;
    if (!st.approved_phases || !st.approved_phases[wp.phase]) continue;
    if (!wp.deps.every((d) => st.wps[d] && st.wps[d].status === "MERGED")) continue;
    if (out.some((o) => writesOverlap(o.write, wp.write))) continue;
    out.push(wp);
    if (out.length >= cap) break;
  }
  return out.map((w) => w.id);
}

function die(msg, code = 1) {
  process.stderr.write(`state: ${msg}\n`);
  process.exit(code);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let root;
  try {
    root = rootDir();
  } catch {
    die("not inside a git repository", 1);
  }
  const flag = (name, dflt) => {
    const i = rest.findIndex((a) => a === `--${name}`);
    if (i < 0) return dflt;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) die(`--${name} needs a value`, 1);
    return v;
  };
  try {
    if (cmd === "init-from-plan") {
      const planRel = flag("plan", "SUBSTRATE-PLAN.md");
      const target = flag("target", "v0.1");
      const workers = Number(flag("workers", "3"));
      const force = rest.includes("--force");
      if (!Number.isInteger(workers) || workers < 1) die("bad --workers N", 1);
      if (fs.existsSync(statePath(root)) && !force) die("state.json exists (use --force to overwrite)", 1);
      const planAbs = path.isAbsolute(planRel) ? planRel : path.resolve(process.cwd(), planRel);
      if (!fs.existsSync(planAbs)) die(`no plan file at ${planRel}`, 2);
      const wps = parsePlan(fs.readFileSync(planAbs, "utf8"));
      if (!wps.length) die("no §16 work packages found in plan", 1);
      const st = {
        release_target: target,
        max_workers: workers,
        approved_phases: { B2: true },
        order: wps.map((w) => w.id),
        wps: Object.fromEntries(wps.map((w) => [w.id, w])),
      };
      saveState(root, st);
      console.log(JSON.stringify({ initialized: wps.length, release_target: target, max_workers: workers }));
    } else if (cmd === "get") {
      const [id] = rest;
      if (!id) die("usage: state.mjs get <WP>", 1);
      const st = loadState(root);
      if (!st.wps[id]) die(`unknown WP ${id}`, 1);
      console.log(JSON.stringify(st.wps[id], null, 2));
    } else if (cmd === "set") {
      const [id, val] = rest;
      if (!id || !val) die("usage: state.mjs set <WP> <STATUS> | set phase:<N> approved", 1);
      const st = loadState(root);
      if (id.startsWith("phase:")) {
        if (val !== "approved") die(`bad phase value ${val} (want approved)`, 1);
        st.approved_phases = st.approved_phases || {};
        st.approved_phases[id.slice("phase:".length)] = true;
        saveState(root, st);
        console.log(JSON.stringify({ phase: id.slice("phase:".length), approved: true }));
        return;
      }
      const err = setWp(st, id, val);
      if (err) die(err, 1);
      saveState(root, st);
      console.log(JSON.stringify({ id, status: st.wps[id].status, gen: st.wps[id].gen, heals: st.wps[id].heals, replans: st.wps[id].replans }));
    } else if (cmd === "list") {
      const [only] = rest;
      const st = loadState(root);
      if (only !== undefined) {
        if (!STATUSES.includes(only.toUpperCase())) die(`bad STATUS ${only}`, 1);
        console.log(JSON.stringify(st.order.filter((id) => st.wps[id] && st.wps[id].status === only.toUpperCase())));
      } else {
        console.log(JSON.stringify(st.order.filter((id) => st.wps[id])));
      }
    } else if (cmd === "next") {
      let limit;
      const i = rest.findIndex((a) => a === "--limit");
      if (i >= 0) {
        limit = Number(rest[i + 1]);
        if (!Number.isInteger(limit) || limit < 1) die("bad --limit K", 1);
      }
      const st = loadState(root);
      console.log(JSON.stringify(eligibleNext(st, limit)));
    } else {
      die("usage: state.mjs init-from-plan|get|set|list|next ...", 1);
    }
  } catch (e) {
    if (e && e.code === "MISSING") die(e.message, 2);
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
