#!/usr/bin/env node
// Validates docs/plan: every work package in PROGRESS.md has a well-formed spec in docs/plan/wp,
// every `write` path exists (or is created by an earlier work package), and no spec is an orphan.
// Usage: node scripts/check-plan.mjs [--root <dir>]
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = path.resolve(rootIdx >= 0 ? args[rootIdx + 1] : process.cwd());
const planDir = path.join(root, "docs/plan");
const wpDir = path.join(planDir, "wp");

const REQUIRED_FIELDS = ["id", "title", "class", "depends_on", "read", "write", "create", "protected", "verify"];
const REQUIRED_HEADINGS = ["Objective", "Interface", "Behavior", "Invariants", "Edge cases", "Guardrails", "Out of scope", "Done when"];
const PLACEHOLDER = /\b(TODO|FIXME|TBD)\b|<placeholder>|\.\.\.\s*$/;
// A line that merely forbids placeholders (for example "no TODO, FIXME ...") is allowed.
const FORBIDS = /\b(no|not|never|forbid\w*|without|nor)\b/i;
const hasPlaceholder = (text) => text.split("\n").some((l) => PLACEHOLDER.test(l) && !FORBIDS.test(l));
const problems = [];
const fail = (id, msg) => problems.push(`${id}: ${msg}`);

function progressRows() {
  const file = path.join(planDir, "PROGRESS.md");
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!/^R\d+\.\d+$/.test(cells[0] ?? "")) continue;
    rows.push({ id: cells[0], title: cells[1], deps: (cells[3] ?? "").split(/\s+/).filter((d) => /^R\d+\.\d+$/.test(d)), status: cells[4] });
  }
  return rows;
}

function parseSpec(file) {
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  return { fm: YAML.parse(m[1]) ?? {}, body: m[2] };
}

const rows = progressRows();
if (rows.length === 0) {
  console.log("check-plan: no docs/plan/PROGRESS.md work packages found; nothing to check");
  process.exit(0);
}

const created = new Map();
for (const row of rows) {
  const file = path.join(wpDir, `${row.id}.md`);
  if (!fs.existsSync(file)) {
    if (row.status !== "DONE") fail(row.id, "spec file docs/plan/wp/" + row.id + ".md is missing");
    continue;
  }
  const spec = parseSpec(file);
  if (!spec) {
    fail(row.id, "no YAML frontmatter");
    continue;
  }
  const { fm, body } = spec;
  for (const f of REQUIRED_FIELDS) if (!(f in fm)) fail(row.id, `frontmatter missing '${f}'`);
  if (fm.id !== row.id) fail(row.id, `frontmatter id '${fm.id}' does not match file name`);
  const heads = new Set([...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((h) => h[1]));
  for (const h of REQUIRED_HEADINGS) if (!heads.has(h)) fail(row.id, `missing heading '## ${h}'`);
  for (const h of REQUIRED_HEADINGS) {
    const sec = body.split(new RegExp(`^##\\s+${h}\\s*$`, "m"))[1]?.split(/^##\s/m)[0] ?? "";
    if (h !== "Out of scope" && sec.trim().length < 20) fail(row.id, `section '${h}' is empty or too short`);
  }
  if (hasPlaceholder(body)) fail(row.id, "contains placeholder text (TODO/FIXME/TBD/...)");
  const deps = (fm.depends_on ?? []).map(String).sort().join(" ");
  const planDeps = [...row.deps].sort().join(" ");
  if (row.deps.length || (fm.depends_on ?? []).length) {
    if (deps !== planDeps) fail(row.id, `depends_on [${deps}] differs from PROGRESS.md deps [${planDeps}]`);
  }
  if (!Array.isArray(fm.verify) || fm.verify.length === 0) fail(row.id, "verify list is empty");
  for (const p of fm.create ?? []) created.set(p, row.id);
  for (const p of [...(fm.write ?? []), ...(fm.read ?? [])]) {
    if (/[*?]/.test(p)) continue;
    const exists = fs.existsSync(path.join(root, p));
    if (!exists && !created.has(p)) fail(row.id, `path '${p}' does not exist and no earlier work package creates it`);
  }
}

if (fs.existsSync(wpDir)) {
  for (const f of fs.readdirSync(wpDir)) {
    const id = f.replace(/\.md$/, "");
    if (!rows.some((r) => r.id === id)) fail(id, "spec file has no row in PROGRESS.md");
  }
}

if (problems.length) {
  for (const p of problems) console.log(p);
  console.log(`FAIL: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`OK: ${rows.length} work package(s) checked`);
