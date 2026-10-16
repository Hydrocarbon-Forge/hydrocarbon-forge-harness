#!/usr/bin/env node
// Bootstrap tool ledger.mjs — append cost/effort ledger lines and print aggregates.
//   node build/tools/ledger.mjs add --role R --tier H|S|O --phase P --tool-uses N --tokens N [--model M]
//   node build/tools/ledger.mjs summary [--phase P]
// summary prints JSON {subagents,tool_uses,tokens,by_tier,by_role}.
// Exit 0 ok, 2 bad args. Node stdlib only. No network.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ROLES = ["researcher", "spec_writer", "test_writer", "worker", "architect", "reviewer"];
export const TIERS = ["H", "S", "O"];

export function rootDir() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

export function ledgerPath(root) {
  return path.join(root, "build", "state", "ledger.jsonl");
}

export function loadLines(root) {
  const p = ledgerPath(root);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function summarize(lines, phase) {
  const filtered = phase === undefined ? lines : lines.filter((l) => l.phase === phase);
  const by_tier = { H: 0, S: 0, O: 0 };
  const by_role = {};
  let tool_uses = 0;
  let tokens = 0;
  for (const l of filtered) {
    const tu = Number(l.tool_uses);
    const tk = Number(l.tokens);
    if (Number.isFinite(tu)) tool_uses += tu;
    if (Number.isFinite(tk)) tokens += tk;
    if (typeof l.tier === "string" && l.tier in by_tier && Number.isFinite(tk)) {
      by_tier[l.tier] += tk;
    }
    if (typeof l.role === "string" && Number.isFinite(tk)) {
      by_role[l.role] = (by_role[l.role] ?? 0) + tk;
    }
  }
  return { subagents: filtered.length, tool_uses, tokens, by_tier, by_role };
}

function usage() {
  process.stderr.write(
    "usage: ledger.mjs add --role R --tier H|S|O --phase P --tool-uses N --tokens N [--model M]\n" +
      "       ledger.mjs summary [--phase P]\n"
  );
  process.exit(2);
}

function getFlag(args, name) {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith("--")) return null; // missing value marker
  return v;
}

function parseNonNegativeNumber(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return NaN;
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "add" && cmd !== "summary") usage();

  let root;
  try {
    root = rootDir();
  } catch {
    process.stderr.write("ledger: not inside a git repository\n");
    process.exit(2);
  }

  if (cmd === "add") {
    // Reject unknown flags early.
    const known = new Set(["--role", "--tier", "--phase", "--tool-uses", "--tokens", "--model"]);
    for (const a of rest) {
      if (a.startsWith("--") && !known.has(a)) {
        process.stderr.write(`ledger: unknown flag ${a}\n`);
        process.exit(2);
      }
    }
    const role = getFlag(rest, "role");
    const tier = getFlag(rest, "tier");
    const phase = getFlag(rest, "phase");
    const toolUsesRaw = getFlag(rest, "tool-uses");
    const tokensRaw = getFlag(rest, "tokens");
    const model = getFlag(rest, "model");

    if (role === undefined || tier === undefined || phase === undefined || toolUsesRaw === undefined || tokensRaw === undefined) {
      usage();
    }
    if (role === null || tier === null || phase === null || toolUsesRaw === null || tokensRaw === null || model === null) {
      usage();
    }
    if (!ROLES.includes(role)) {
      process.stderr.write(`ledger: unknown role ${role}\n`);
      process.exit(2);
    }
    if (!TIERS.includes(tier)) {
      process.stderr.write(`ledger: unknown tier ${tier}\n`);
      process.exit(2);
    }
    if (typeof phase !== "string" || phase.trim() === "") {
      process.stderr.write("ledger: --phase needs a value\n");
      process.exit(2);
    }
    const tool_uses = parseNonNegativeNumber(toolUsesRaw);
    const tokens = parseNonNegativeNumber(tokensRaw);
    if (tool_uses === undefined || tokens === undefined || Number.isNaN(tool_uses) || Number.isNaN(tokens)) {
      process.stderr.write("ledger: --tool-uses and --tokens must be numeric\n");
      process.exit(2);
    }

    const entry = {
      ts: new Date().toISOString(),
      role,
      tier,
      phase,
      tool_uses,
      tokens,
    };
    if (model !== undefined) entry.model = model;

    const p = ledgerPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
    return;
  }

  // summary
  const knownSummary = new Set(["--phase"]);
  for (const a of rest) {
    if (a.startsWith("--") && !knownSummary.has(a)) {
      process.stderr.write(`ledger: unknown flag ${a}\n`);
      process.exit(2);
    }
  }
  let phase;
  if (rest.includes("--phase")) {
    phase = getFlag(rest, "phase");
    if (phase === undefined || phase === null || phase.trim() === "") usage();
  } else if (rest.length > 0) {
    usage();
  }
  const lines = loadLines(root);
  const out = summarize(lines, phase);
  console.log(JSON.stringify(out));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
