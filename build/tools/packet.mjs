#!/usr/bin/env node
// Bootstrap failure-packet assembler:
//   node build/tools/packet.mjs <WP> [--gen N] [--scope PATH] [--message TEXT]
// Assembles a failure packet JSON for a failed WP from its verify report, an
// optional scope-check result and a capped worktree diff. Writes
// build/packets/<WP>.g<N>.json plus build/packets/<WP>.g<N>.patch.
// Exit 0 ok, 1 missing/unreadable verify report, 2 usage error.
// Node stdlib only. Git is read-only here (diff); no network, no transcripts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PATCH_CAP = 200 * 1024; // patch is capped at 200 KB, cut from the tail
export const MESSAGE_CAP = 2000; // worker one-liner is capped, stored as untrusted
export const TAIL_CAP = 8000; // each verify command tail is capped when embedded

const WP_RE = /^[A-Za-z0-9._-]+$/;
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

// One frontmatter list (inline [a, b] or a "- item" block) from a spec file.
export function fmList(text, key) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];
  const lines = m[1].split("\n");
  let out = null;
  for (const line of lines) {
    const k = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (k) {
      if (k[1] === key) {
        const v = k[2].trim();
        if (v.startsWith("[")) {
          const end = v.lastIndexOf("]");
          return v.slice(1, end < 0 ? undefined : end).split(",").map(unquote).filter(Boolean);
        }
        out = [];
        continue;
      }
      if (out) break;
      continue;
    }
    if (out) {
      const it = line.match(/^\s+-\s+(.*)$/);
      if (it) out.push(unquote(it[1]));
      else if (line.trim() === "") continue;
      else break;
    }
  }
  return out || [];
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// Generation of <WP> from build/state/state.json (tolerant of its shape); undefined when absent.
export function stateGen(state, wp) {
  const cands = [];
  if (state && typeof state === "object") {
    if (!Array.isArray(state.tasks) && state.tasks && typeof state.tasks === "object") cands.push(state.tasks[wp]);
    if (state.wps && typeof state.wps === "object") cands.push(state.wps[wp]);
    if (Array.isArray(state.tasks)) cands.push(state.tasks.find((t) => t && t.id === wp));
    if (Array.isArray(state)) cands.push(state.find((t) => t && t.id === wp));
    if (!Array.isArray(state)) cands.push(state[wp]);
  }
  for (const c of cands) {
    const n = Number(c && (c.gen ?? c.generation));
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

// WP ids whose deps list <WP> ([] when state.json is absent or has no such entries).
export function stateDependents(state, wp) {
  let entries = [];
  if (state && typeof state === "object") {
    if (Array.isArray(state.tasks)) entries = state.tasks;
    else if (state.tasks && typeof state.tasks === "object") {
      entries = Object.entries(state.tasks).map(([id, v]) => ({ id, ...((v && typeof v === "object") ? v : {}) }));
    } else if (state.wps && typeof state.wps === "object") {
      entries = Object.entries(state.wps).map(([id, v]) => ({ id, ...((v && typeof v === "object") ? v : {}) }));
    } else if (Array.isArray(state)) entries = state;
  }
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object" || typeof e.id !== "string") continue;
    const deps = e.depends_on ?? e.deps ?? e.dependencies;
    if (Array.isArray(deps) && deps.includes(wp)) out.push(e.id);
  }
  return out.sort();
}

// Split a scope-check result into protected-file entries vs scope violations
// (tolerant of the exact key names; scope.mjs is built separately).
export function scopeSignals(obj) {
  const prot = [];
  const viol = [];
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const vals = Array.isArray(v)
        ? v.filter((x) => typeof x === "string" && x)
        : (typeof v === "string" && v ? [v] : []);
      if (/protect/i.test(k)) prot.push(...vals);
      else if (/violat|out_of_scope|outOfScope|revert/i.test(k)) viol.push(...vals);
    }
  }
  return { protected_modified: prot, violations: viol };
}

// Cap a string at cap bytes, cutting from the tail (prefer a newline boundary).
export function capBytes(s, cap) {
  const b = Buffer.from(s, "utf8");
  if (b.length <= cap) return { text: s, truncated: false };
  let cut = b.subarray(0, cap).toString("utf8");
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl + 1);
  return { text: cut, truncated: true };
}

function verifyOutput(report) {
  const results = report && Array.isArray(report.results) ? report.results : [];
  return results.map((r) => {
    const raw = r.tail ?? [r.stdout_tail, r.stderr_tail].filter(Boolean).join("\n");
    let tail = String(raw ?? "");
    if (tail.length > TAIL_CAP) tail = tail.slice(0, TAIL_CAP);
    return {
      cmd: String(r.cmd ?? r.run ?? ""),
      exit: r.exit ?? r.exit_code ?? null,
      timed_out: Boolean(r.timed_out ?? r.timedOut),
      tail,
    };
  });
}

function collectDiff(wtDir) {
  if (!fs.existsSync(wtDir)) return { stat: "worktree gone", patch: "", truncated: false };
  try {
    const run = (...a) => execFileSync("git", a, {
      cwd: wtDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const stat = run("diff", "--stat", "--no-color");
    const { text, truncated } = capBytes(run("diff", "--no-color"), PATCH_CAP);
    return { stat, patch: text, truncated };
  } catch (e) {
    const line = String((e && e.stderr) || (e && e.message) || e).trim().split("\n")[0];
    return { stat: `git diff failed: ${line}`.slice(0, 500), patch: "", truncated: false };
  }
}

function usage() {
  process.stderr.write("usage: packet.mjs <WP> [--gen N] [--scope PATH] [--message TEXT]\n");
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const die = (code, m) => { process.stderr.write(`packet: ${m}\n`); process.exit(code); };
  let wp = null;
  let gen = null;
  let scopePath = null;
  let message = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--gen") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) usage();
      gen = n;
    } else if (a === "--scope") {
      scopePath = args[++i];
      if (!scopePath) usage();
    } else if (a === "--message") {
      if (i + 1 >= args.length) usage();
      message = String(args[++i]);
    } else if (a.startsWith("--") || a.startsWith("-")) {
      usage();
    } else if (!wp) {
      wp = a;
    } else {
      usage();
    }
  }
  if (!wp || !WP_RE.test(wp)) usage();

  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    die(2, "not inside a git repository");
  }

  const reportPath = path.join(root, "build/reports", `${wp}.verify.json`);
  if (!fs.existsSync(reportPath)) die(1, `no verify report at build/reports/${wp}.verify.json`);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (e) {
    die(1, `cannot parse verify report: ${e.message}`);
  }

  let scope = { protected_modified: [], violations: [] };
  if (scopePath) {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(scopePath, "utf8"));
    } catch (e) {
      die(2, `cannot read scope file ${scopePath}: ${e.message}`);
    }
    scope = scopeSignals(obj);
  }

  const failure_class = scope.protected_modified.length > 0
    ? "protected_modified"
    : scope.violations.length > 0
      ? "scope_violation"
      : "verify_failed";

  const specFile = path.join(root, "build/specs", `${wp}.md`);
  const related_contracts = fs.existsSync(specFile) ? fmList(fs.readFileSync(specFile, "utf8"), "read") : [];

  const statePath = path.join(root, "build/state/state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : undefined;
  if (gen == null) gen = stateGen(state, wp) ?? 1;
  const dependents = stateDependents(state, wp);

  const { stat, patch, truncated } = collectDiff(path.join(root, ".worktrees", wp));

  const base = `${wp}.g${gen}`;
  const patchRel = `build/packets/${base}.patch`;
  fs.mkdirSync(path.join(root, "build/packets"), { recursive: true });
  fs.writeFileSync(path.join(root, patchRel), patch);

  const output = verifyOutput(report);
  const packet = {
    wp,
    generation: gen,
    failure_class,
    spec_path: `build/specs/${wp}.md`,
    verify_report: `build/reports/${wp}.verify.json`,
    verify_ok: Boolean(report.ok ?? output.every((r) => r.exit === 0)),
    verify_output: output,
    scope_violations: scope.violations,
    protected_modified: scope.protected_modified,
    worker_summary: message.slice(0, MESSAGE_CAP),
    worker_summary_untrusted: true,
    related_contracts,
    dependents,
    diff: { stat, patch_path: patchRel, truncated },
    created_at: new Date().toISOString(),
  };
  const outRel = `build/packets/${base}.json`;
  fs.writeFileSync(path.join(root, outRel), `${JSON.stringify(packet, null, 2)}\n`);
  console.log(outRel);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
