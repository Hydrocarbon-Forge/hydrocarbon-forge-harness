#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot, listFiles, normalizeSlashes } from "./lib/scan.mjs";
import { loadAllowlist, saveAllowlist, workPackageStatus, applyAllowlist } from "./lib/allowlist.mjs";

/**
 * Extracts the canonical event vocabulary from src/contracts/events.ts or SUBSTRATE-PLAN.md Appendix D.
 */
export function getEventVocabulary(root) {
  const eventsFile = path.resolve(root, "src/contracts/events.ts");
  if (fs.existsSync(eventsFile)) {
    const text = fs.readFileSync(eventsFile, "utf8");
    const matches = text.match(/["']([a-z]+(?:\.[a-z]+)+)["']/g) || [];
    return new Set(matches.map((m) => m.slice(1, -1)));
  }

  const planFile = path.resolve(root, "SUBSTRATE-PLAN.md");
  const vocab = new Set(["plan.ready", "integration.failed", "tasks.invalidated", "task.verify.started"]);
  if (fs.existsSync(planFile)) {
    const text = fs.readFileSync(planFile, "utf8");
    const appDIdx = text.indexOf("## Appendix D");
    if (appDIdx !== -1) {
      const nextSecIdx = text.indexOf("## Appendix E", appDIdx);
      const section = nextSecIdx !== -1 ? text.slice(appDIdx, nextSecIdx) : text.slice(appDIdx);
      const backticked = section.match(/`([a-z0-9_.-]+)`/g) || [];
      for (const b of backticked) {
        const name = b.slice(1, -1);
        if (/^[a-z]+(?:\.[a-z]+)+$/.test(name)) {
          vocab.add(name);
        }
      }
    }
  }
  return vocab;
}

/**
 * Scans src/engine and src/cli for emitted and consumed events.
 * Returns violations: { type, kind, path, line, message }.
 */
export function scanEvents(root, observeOnly = []) {
  const vocab = getEventVocabulary(root);
  const observeSet = new Set(observeOnly);

  // 1. Emitted events in src/engine/**
  // Emitted = first string-literal argument of emit(...) or type: "..." in engine
  const engineFiles = listFiles(root, "src/engine", [".ts"]);
  const emittedMap = new Map(); // eventType -> { path, line }[]

  for (const relPath of engineFiles) {
    const absPath = path.resolve(root, relPath);
    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // emit("x", ...) or emit('x', ...)
      const emitRe = /\bemit\(\s*["']([a-z0-9_.-]+)["']/g;
      let m;
      while ((m = emitRe.exec(line)) !== null) {
        const type = m[1];
        if (!emittedMap.has(type)) emittedMap.set(type, []);
        emittedMap.get(type).push({ path: relPath, line: i + 1 });
      }

      // Direct event object creation: type: "x" (where x is in vocabulary or matches dotted event name)
      const typePropRe = /\btype:\s*["']([a-z]+(?:\.[a-z]+)+)["']/g;
      while ((m = typePropRe.exec(line)) !== null) {
        const type = m[1];
        if (vocab.has(type) || /^[a-z]+(?:\.[a-z]+)+$/.test(type)) {
          if (!emittedMap.has(type)) emittedMap.set(type, []);
          emittedMap.get(type).push({ path: relPath, line: i + 1 });
        }
      }
    }
  }

  // 2. Consumed events in src/engine/reducer.ts and src/cli/**
  // Consumed = case "x": or type === "x" / type == "x"
  const consumedMap = new Map(); // eventType -> { path, line }[]

  const reducerFile = "src/engine/reducer.ts";
  const absReducer = path.resolve(root, reducerFile);
  if (fs.existsSync(absReducer)) {
    const content = fs.readFileSync(absReducer, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const caseRe = /case\s*["']([a-z0-9_.-]+)["']\s*:/g;
      let m;
      while ((m = caseRe.exec(line)) !== null) {
        const type = m[1];
        if (!consumedMap.has(type)) consumedMap.set(type, []);
        consumedMap.get(type).push({ path: reducerFile, line: i + 1 });
      }

      const typeEqRe = /(?:\.|\b)type\s*===?\s*["']([a-z0-9_.-]+)["']/g;
      while ((m = typeEqRe.exec(line)) !== null) {
        const type = m[1];
        if (!consumedMap.has(type)) consumedMap.set(type, []);
        consumedMap.get(type).push({ path: reducerFile, line: i + 1 });
      }
    }
  }

  const cliFiles = listFiles(root, "src/cli", [".ts"]);
  for (const relPath of cliFiles) {
    const absPath = path.resolve(root, relPath);
    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const typeEqRe = /(?:\.|\b)type\s*===?\s*["']([a-z0-9_.-]+)["']/g;
      let m;
      while ((m = typeEqRe.exec(line)) !== null) {
        const type = m[1];
        if (!consumedMap.has(type)) consumedMap.set(type, []);
        consumedMap.get(type).push({ path: relPath, line: i + 1 });
      }
    }
  }

  const violations = [];

  // consumed-not-emitted
  for (const [type, occurrences] of consumedMap.entries()) {
    if (!emittedMap.has(type)) {
      for (const occ of occurrences) {
        violations.push({
          rule: "consumed-not-emitted",
          type,
          kind: "consumed-not-emitted",
          path: occ.path,
          line: occ.line,
          message: `Event type "${type}" is consumed but never emitted`,
        });
      }
    }
  }

  // emitted-not-consumed
  for (const [type, occurrences] of emittedMap.entries()) {
    if (!consumedMap.has(type) && !observeSet.has(type)) {
      for (const occ of occurrences) {
        violations.push({
          rule: "emitted-not-consumed",
          type,
          kind: "emitted-not-consumed",
          path: occ.path,
          line: occ.line,
          message: `Event type "${type}" is emitted but never consumed`,
        });
      }
    }
  }

  return violations.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });
}

function parseArgs(args) {
  let root = null;
  let allowlist = null;
  let progress = null;
  let initAllowlist = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = path.resolve(args[++i]);
    } else if (args[i] === "--allowlist" && i + 1 < args.length) {
      allowlist = path.resolve(args[++i]);
    } else if (args[i] === "--progress" && i + 1 < args.length) {
      progress = path.resolve(args[++i]);
    } else if (args[i] === "--init-allowlist") {
      initAllowlist = true;
    }
  }

  const projRoot = root || findProjectRoot();
  return {
    root: projRoot,
    allowlistFile: allowlist || path.join(projRoot, "scripts/debt-allowlist.json"),
    progressFile: progress || path.join(projRoot, "docs/plan/PROGRESS.md"),
    initAllowlist,
  };
}

export async function main() {
  try {
    const { root, allowlistFile, progressFile, initAllowlist } = parseArgs(process.argv.slice(2));
    const allowlist = loadAllowlist(allowlistFile);
    const observeOnly = allowlist.events_observe_only || [];
    const violations = scanEvents(root, observeOnly);

    if (initAllowlist) {
      const data = loadAllowlist(allowlistFile);
      const existing = data.events || [];
      const entryMap = new Map();
      for (const e of existing) {
        entryMap.set(`${e.type}:${e.kind}`, e);
      }

      for (const v of violations) {
        const key = `${v.type}:${v.kind}`;
        if (!entryMap.has(key)) {
          // Table: consumed-not-emitted -> R1.2, emitted-not-consumed -> R1.2
          entryMap.set(key, { type: v.type, kind: v.kind, until: "R1.2" });
        }
      }

      data.events = Array.from(entryMap.values()).sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        return a.kind.localeCompare(b.kind);
      });
      data.events_observe_only = data.events_observe_only || [];
      saveAllowlist(allowlistFile, data);
      console.log(`Updated events allowlist in ${allowlistFile} (${data.events.length} entries)`);
      process.exit(0);
    }

    const status = workPackageStatus(progressFile);
    const { remaining, problems } = applyAllowlist("events", violations, allowlist, status);

    for (const v of remaining) {
      console.log(`${v.rule} ${v.path}:${v.line} ${v.message}`);
    }
    for (const p of problems) {
      const relAllow = normalizeSlashes(path.relative(root, allowlistFile));
      console.log(`ALLOWLIST ${relAllow}:1 ${p}`);
    }

    const totalFails = remaining.length + problems.length;
    if (totalFails > 0) {
      console.log(`FAIL: ${totalFails} violation(s)`);
      process.exit(1);
    }

    console.log("OK");
    process.exit(0);
  } catch (err) {
    console.error(`Error running check-events: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
