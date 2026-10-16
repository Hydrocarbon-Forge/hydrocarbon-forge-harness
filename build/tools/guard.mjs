#!/usr/bin/env node
// Substrate build guard: a Claude Code PreToolUse hook whose only job is to keep parallel workers from trampling each other.
// It governs workers and test-writers only; the orchestrator and every other role pass untouched.
//   - They may write only inside their own worktree (.worktrees/<WP>/) and only the files their spec allows.
//   - Each worker is bound to the first worktree it writes in, and each worktree to its first worker.
//   - They cannot run git commands that change state shared between worktrees.
// Exit 0 = continue, exit 2 = block (stderr is shown to the model). Self-test: node --test build/tools/guard.test.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ROLES = {
  "substrate-test-writer": "test-writer",
  "substrate-worker-s": "worker",
  "substrate-worker-m": "worker",
  "substrate-worker-l": "worker",
};
const SHARED_GIT = /\bgit\s+(-C|--git-dir|--work-tree|worktree|branch|stash|gc|prune|update-ref|tag|remote|config|push|fetch|pull)\b/;

const ok = () => ({ ok: true });
const deny = (reason) => ({ ok: false, reason });

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
export const match = (globs, rel) => (globs || []).some((g) => globRe(g).test(rel));

function realish(p) { // resolve symlinks of the deepest existing ancestor, keep the not-yet-existing tail
  let cur = path.resolve(p); const rest = [];
  while (!fs.existsSync(cur)) { rest.unshift(path.basename(cur)); const up = path.dirname(cur); if (up === cur) break; cur = up; }
  return path.join(fs.realpathSync(cur), ...rest);
}
const within = (base, abs) => { const r = path.relative(base, abs); return !r.startsWith("..") && !path.isAbsolute(r) ? r : null; };

// A worker is bound to the first worktree it writes in, and a worktree to the first worker that writes in it (atomic
// claim files). No agent_id means path scoping only.
function bind(R, wp, role, agentId) {
  if (!agentId) return null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) return "invalid agent_id";
  const dir = path.join(R, "build/state/claims");
  fs.mkdirSync(dir, { recursive: true });
  const claim = (file, value) => {
    try { fs.writeFileSync(file, value, { flag: "wx" }); return value; }
    catch (e) { if (e.code !== "EEXIST") throw e; return fs.readFileSync(file, "utf8").trim(); }
  };
  const agentFile = path.join(dir, `agent-${agentId}`);
  const bound = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, "utf8").trim() : null;
  if (bound && bound !== wp) return `this agent is bound to ${bound}, not ${wp}: another worker's worktree is off limits`;
  const owner = claim(path.join(dir, `${wp}.${role}`), agentId);
  if (owner !== agentId) return `${wp} is already owned by another ${role}; if the owner is gone, run: node build/tools/wt.mjs release ${wp}`;
  claim(agentFile, wp); // bind only after the worktree is ours, so a denied worker is never bound
  return null;
}

function writePolicy(role, f, R, p) {
  const rel = within(R, realish(path.resolve(R, f)));
  if (rel === null) return deny("write outside the repository");
  const m = rel.match(/^\.worktrees\/([A-Za-z0-9._-]+)\/(.+)$/);
  if (!m) return deny("workers write only inside their own worktree (.worktrees/<WP>/)");
  const [, wp, inner] = m;
  if (match([".substrate-task/**"], inner)) return deny("the task file is read-only");
  let scope;
  try { scope = JSON.parse(fs.readFileSync(path.join(R, "build/state/scope", wp + ".json"), "utf8")); }
  catch { return deny(`no scope file for ${wp}`); }
  if (match(scope.deny, inner)) return deny(`${inner} is protected by the spec`);
  const allowed = role === "test-writer" ? scope.allow_test_writer : scope.allow_worker;
  if (!match(allowed, inner)) return deny(`${inner} is outside the spec's write/create set`);
  const conflict = bind(R, wp, role, p.agent_id);
  return conflict ? deny(conflict) : ok();
}

export function decide(p, root = process.env.GUARD_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const role = ROLES[p.agent_type];
  if (!role) return ok();
  const ti = p.tool_input || {};
  if (WRITE.has(p.tool_name)) {
    const f = ti.file_path ?? ti.notebook_path;
    return typeof f === "string" && f ? writePolicy(role, f, realish(root), p) : deny("write without a recognizable path");
  }
  if (p.tool_name === "Bash" && SHARED_GIT.test(String(ti.command ?? ""))) {
    return deny("git commands that change state shared between worktrees (worktree, branch, stash, -C, push, ...) are the engine's job");
  }
  return ok();
}

function audit(root, entry) {
  try {
    const f = path.join(root, "build/state/guard.log");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* auditing must never break the decision */ }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let p;
  try { p = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); } // cannot tell who is calling: do not get in the way
  if (!ROLES[p.agent_type]) process.exit(0);
  let d;
  try { d = decide(p); } catch (e) { d = deny("guard error: " + e.message); }
  const ti = p.tool_input || {};
  audit(process.env.GUARD_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd(), {
    role: p.agent_type, agent_id: p.agent_id, tool: p.tool_name, ok: d.ok, reason: d.reason,
    target: ti.file_path ?? ti.notebook_path ?? (ti.command ? String(ti.command).slice(0, 120) : undefined) });
  if (!d.ok) { process.stderr.write(`Blocked by Substrate guard: ${d.reason}\n`); process.exit(2); }
}
