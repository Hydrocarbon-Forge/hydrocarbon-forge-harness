#!/usr/bin/env node
// speccheck.mjs — validate a task spec's shape without judging its content.
//   node build/tools/speccheck.mjs <WP>
// Reads build/specs/<WP>.md (located by walking up from the cwd) and prints
// SPEC OK or the full error list.
// Exit 0 = valid, 1 = invalid, 2 = missing spec / usage.
// Node stdlib only. Read-only; deterministic; never shells out.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WP_RE = /^[A-Za-z0-9._-]+$/;
const REQUIRED_FIELDS = ["id", "title", "class", "depends_on", "read", "write", "create", "protected", "verify"];
const LIST_FIELDS = ["depends_on", "read", "write", "create", "protected"];
const PATH_FIELDS = ["read", "write", "create", "protected"];
const REQUIRED_HEADINGS = ["Objective", "Interface", "Behavior", "Invariants", "Edge cases", "Guardrails", "Out of scope"];
const MAX_FENCE_LINES = 12;
// Glob characters allowed in path entries are only `*`, `?` and `/`
// (with `**` built from `*`). Anything else glob-like is rejected.
const BAD_GLOB = /[[{}()!+@\\\]|]/;

const stripQuotes = (s) => {
  s = String(s).trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
};

// Split an inline `[...]` body on top-level commas (quotes respected).
function splitInline(inner) {
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      if (c === q) q = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== "").map(stripQuotes);
}

const coerce = (v) => {
  v = stripQuotes(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
};

// Parse `{ run: "...", timeout_s: 60 }`; null when not a flow map.
function parseFlowMap(s) {
  s = String(s).trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  const obj = {};
  for (const part of splitInline(s.slice(1, -1))) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    obj[part.slice(0, idx).trim()] = coerce(part.slice(idx + 1));
  }
  return obj;
}

// Minimal frontmatter reader: inline `[a, b]` lists, block `- item` lists,
// flow-map verify entries, and block-style `run:`/`timeout_s:` verify entries.
// Throws on structurally malformed input; the caller turns that into an error.
function parseFrontmatter(fm) {
  const data = {};
  let listKey = null;
  let lastKey = null;
  let pending = null; // block-style verify entry under construction
  const flush = () => {
    if (pending) {
      data.verify.push(pending);
      pending = null;
    }
  };
  for (const rawLine of fm.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    const indented = /^\s/.test(line);
    if (kv && !indented) {
      flush();
      const key = kv[1];
      const val = kv[2].trim();
      listKey = null;
      lastKey = key;
      if (key === "verify") {
        data.verify = [];
        if (val.startsWith("[")) {
          if (val.lastIndexOf("]") < 0) throw new Error("malformed inline list for 'verify'");
          for (const m of val.match(/\{[^}]*\}/g) || []) data.verify.push(parseFlowMap(m));
        } else if (val !== "") {
          throw new Error("malformed value for 'verify'");
        }
      } else if (LIST_FIELDS.includes(key)) {
        if (val.startsWith("[")) {
          const close = val.lastIndexOf("]");
          if (close < 0) throw new Error(`malformed inline list for '${key}'`);
          data[key] = splitInline(val.slice(1, close));
        } else if (val === "") {
          data[key] = [];
          listKey = key;
        } else {
          data[key] = [stripQuotes(val)];
        }
      } else if (["id", "title", "class"].includes(key)) {
        data[key] = stripQuotes(val);
      }
      // Unknown top-level keys are ignored (shape check only cares about required ones).
      continue;
    }
    const dash = line.match(/^\s*-\s+(.*)$/);
    if (dash) {
      flush();
      const v = dash[1].trim();
      if (lastKey && listKey === lastKey && LIST_FIELDS.includes(lastKey)) {
        data[lastKey].push(stripQuotes(v));
        continue;
      }
      if (lastKey === "verify" && Array.isArray(data.verify)) {
        const m = v.startsWith("{") ? parseFlowMap(v) : null;
        if (m) {
          data.verify.push(m);
          continue;
        }
        const rkv = v.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (rkv) {
          pending = { [rkv[1]]: coerce(rkv[2]) };
          continue;
        }
        data.verify.push(v); // scalar entry: fails validation below with a proper error
        continue;
      }
      continue; // stray list item outside any known key: ignore
    }
    const cont = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (cont && pending && lastKey === "verify") {
      pending[cont[1]] = coerce(cont[2]);
      continue;
    }
    if (line.trim() && !indented) throw new Error(`malformed line in frontmatter: '${line.trim().slice(0, 60)}'`);
  }
  flush();
  return data;
}

// Split text into frontmatter and body. Returns { fm, body, ok }.
function splitDoc(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return { fm: null, body: text, ok: false };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return { fm: lines.slice(1).join("\n"), body: "", ok: false };
  return { fm: lines.slice(1, close).join("\n"), body: lines.slice(close + 1).join("\n"), ok: true };
}

function checkShape(data, fmOk, body, wp) {
  const errors = [];
  if (!fmOk) {
    errors.push("frontmatter: missing or malformed (expected a --- block)");
  } else {
    for (const f of REQUIRED_FIELDS) {
      if (!(f in data)) errors.push(`frontmatter: missing required field '${f}'`);
    }
    if ("id" in data && String(data.id) !== wp) {
      errors.push(`frontmatter: id '${data.id}' does not match filename '${wp}'`);
    }
    for (const f of ["title", "class"]) {
      if (f in data && (typeof data[f] !== "string" || !data[f].trim())) {
        errors.push(`frontmatter: '${f}' must be a non-empty string`);
      }
    }
    for (const f of LIST_FIELDS) {
      if (f in data && !Array.isArray(data[f])) errors.push(`frontmatter: '${f}' must be a list`);
    }
    if ("verify" in data) {
      if (!Array.isArray(data.verify) || data.verify.length === 0) {
        errors.push("frontmatter: 'verify' must be a non-empty list");
      } else {
        data.verify.forEach((e, i) => {
          if (typeof e !== "object" || e === null || Array.isArray(e)) {
            errors.push(`frontmatter: verify[${i}] must be a mapping with 'run' and 'timeout_s'`);
            return;
          }
          if (typeof e.run !== "string" || !e.run.trim()) {
            errors.push(`frontmatter: verify[${i}] missing 'run'`);
          }
          if (typeof e.timeout_s !== "number" || !Number.isFinite(e.timeout_s) || e.timeout_s <= 0) {
            errors.push(`frontmatter: verify[${i}] missing numeric 'timeout_s'`);
          }
        });
      }
    }
    for (const f of PATH_FIELDS) {
      if (!Array.isArray(data[f])) continue;
      for (const p of data[f]) {
        if (typeof p !== "string" || !p) {
          errors.push(`paths: '${f}' contains an empty entry`);
          continue;
        }
        if (p.startsWith("/")) errors.push(`paths: '${f}' entry '${p}' is absolute`);
        if (p.split("/").includes("..")) errors.push(`paths: '${f}' entry '${p}' contains '..'`);
        if (BAD_GLOB.test(p)) {
          errors.push(`paths: '${f}' entry '${p}' uses glob characters other than * ? ** and /`);
        }
      }
    }
  }

  const heads = new Set();
  for (const m of body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) heads.add(m[1].trim());
  for (const h of REQUIRED_HEADINGS) {
    if (!heads.has(h)) errors.push(`body: missing heading '${h}'`);
  }

  // Code fences: none longer than MAX_FENCE_LINES lines. Every violation reported.
  const bodyLines = body.split("\n");
  let fenceStart = -1;
  let fenceCount = 0;
  bodyLines.forEach((ln, idx) => {
    if (/^\s*`{3,}/.test(ln)) {
      if (fenceStart < 0) {
        fenceStart = idx + 1; // 1-based line number within the body
        fenceCount = 0;
      } else {
        if (fenceCount > MAX_FENCE_LINES) {
          errors.push(`fences: code block starting at body line ${fenceStart} has ${fenceCount} lines (max ${MAX_FENCE_LINES})`);
        }
        fenceStart = -1;
      }
      return;
    }
    if (fenceStart >= 0) fenceCount++;
  });
  if (fenceStart >= 0) errors.push(`fences: unclosed code block starting at body line ${fenceStart}`);

  return errors;
}

function findSpec(wp) {
  let dir = path.resolve(process.cwd());
  for (;;) {
    const cand = path.join(dir, "build", "specs", `${wp}.md`);
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch { /* keep walking up */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || !WP_RE.test(argv[0])) {
    process.stderr.write("usage: speccheck.mjs <WP>\n");
    process.exit(2);
  }
  const wp = argv[0];
  const specFile = findSpec(wp);
  if (!specFile) {
    process.stdout.write(`SPEC MISSING: build/specs/${wp}.md not found\n`);
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(specFile, "utf8");
  } catch {
    process.stdout.write(`SPEC MISSING: build/specs/${wp}.md not found\n`);
    process.exit(2);
  }
  if (!text.trim()) {
    process.stdout.write("SPEC INVALID: 1 error(s)\n- body: empty file\n");
    process.exit(1);
  }
  const { fm, body, ok } = splitDoc(text);
  let data = {};
  let errors;
  try {
    if (fm !== null) data = parseFrontmatter(fm);
    errors = checkShape(data, ok, body, wp);
  } catch (e) {
    errors = [`frontmatter: malformed (${String(e.message || e).slice(0, 120)})`];
    errors.push(...checkShape({}, false, body, wp).filter((m) => m.startsWith("body:") || m.startsWith("fences:")));
  }
  // checkShape with fmOk=false already reports the frontmatter problem, so do
  // not double-report when parsing succeeded but delimiters were missing.
  if (errors.length === 0) {
    process.stdout.write("SPEC OK\n");
    process.exit(0);
  }
  process.stdout.write(`SPEC INVALID: ${errors.length} error(s)\n${errors.map((e) => `- ${e}`).join("\n")}\n`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
