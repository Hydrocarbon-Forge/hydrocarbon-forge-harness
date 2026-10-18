#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot, listFiles, normalizeSlashes, importSpecifiers, resolveRelativeImport } from "./lib/scan.mjs";
import { loadAllowlist, saveAllowlist, workPackageStatus, applyAllowlist } from "./lib/allowlist.mjs";
import { analyzeDead } from "./check-dead-exports.mjs";

/**
 * Builds the module-level import graph from src files and returns unreachable files.
 * @param {string} root - project root directory
 * @param {string[]} entryFiles - repo-relative entry file paths
 * @returns {Array<{ rule: string, path: string, line: number, message: string }>}
 */
export function scanWired(root, entryFiles = ["src/cli/main.ts", "src/cli/dispatcher.ts", "src/index.ts"]) {
  const allFiles = listFiles(root, "src", [".ts"]);
  const allFilesSet = new Set(allFiles);

  // Adjacency list: file -> Set of imported files
  const graph = new Map();
  for (const file of allFiles) {
    graph.set(file, new Set());
    const absPath = path.resolve(root, file);
    try {
      const content = fs.readFileSync(absPath, "utf8");
      const specs = importSpecifiers(content, file);
      for (const item of specs) {
        const resolved = resolveRelativeImport(file, item.specifier, root);
        if (resolved && allFilesSet.has(resolved)) {
          graph.get(file).add(resolved);
        }
      }
    } catch {
      // Ignore read errors (handled elsewhere)
    }
  }

  // BFS / DFS from entries
  const reachable = new Set();
  const queue = [];

  for (const entry of entryFiles) {
    const normalized = normalizeSlashes(entry);
    if (allFilesSet.has(normalized)) {
      reachable.add(normalized);
      queue.push(normalized);
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift();
    const neighbors = graph.get(curr) || new Set();
    for (const next of neighbors) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const unreachable = [];
  for (const file of allFiles) {
    if (!reachable.has(file)) {
      unreachable.push({
        rule: "UNREACHABLE",
        path: file,
        line: 1,
        message: "File is not reachable from entry points",
      });
    }
  }

  return unreachable.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Assigns `until` tag to unreachable file during --init-allowlist.
 */
function assignUntil(relPath) {
  if (relPath.startsWith("src/tui/")) return { path: "src/tui/**", until: "R0.7" };
  if (relPath === "src/cli/bench.ts" || relPath === "src/cli/agents-import.ts") return { path: relPath, until: "R1.8" };
  if (relPath === "src/store/event-store.ts") return { path: relPath, until: "R3.2" };
  if (relPath === "src/ledger/index.ts") return { path: relPath, until: "R1.4" };
  if (relPath === "src/engine/scheduler.ts") return { path: relPath, until: "R3.2" };
  if (relPath === "src/engine/replan.ts") return { path: relPath, until: "R3.5" };
  if (relPath === "src/roles/worker.ts") return { path: relPath, until: "R3.3" };
  if (relPath === "src/roles/planner.ts") return { path: relPath, until: "R3.1" };

  console.warn(`Warning: unmapped unreachable file ${relPath}; defaulting until to R5.3`);
  return { path: relPath, until: "R5.3" };
}

function parseArgs(args) {
  let root = null;
  let allowlist = null;
  let progress = null;
  let initAllowlist = false;
  let entries = ["src/cli/main.ts", "src/cli/dispatcher.ts", "src/index.ts"];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = path.resolve(args[++i]);
    } else if (args[i] === "--allowlist" && i + 1 < args.length) {
      allowlist = path.resolve(args[++i]);
    } else if (args[i] === "--progress" && i + 1 < args.length) {
      progress = path.resolve(args[++i]);
    } else if (args[i] === "--entries" && i + 1 < args.length) {
      entries = args[++i].split(",").map((s) => s.trim());
    } else if (args[i] === "--init-allowlist") {
      initAllowlist = true;
    }
  }

  const projRoot = root || findProjectRoot();
  return {
    root: projRoot,
    allowlistFile: allowlist || path.join(projRoot, "scripts/debt-allowlist.json"),
    progressFile: progress || path.join(projRoot, "docs/plan/PROGRESS.md"),
    entries,
    initAllowlist,
  };
}

export async function main() {
  try {
    const { root, allowlistFile, progressFile, entries, initAllowlist } = parseArgs(process.argv.slice(2));
    const wiredViolations = scanWired(root, entries);

    if (initAllowlist) {
      const data = loadAllowlist(allowlistFile);
      const existing = data.wired || [];
      const entryMap = new Map();
      for (const e of existing) {
        entryMap.set(e.path, e);
      }

      for (const v of wiredViolations) {
        const { path: allowPath, until } = assignUntil(v.path);
        if (!entryMap.has(allowPath)) {
          entryMap.set(allowPath, { path: allowPath, until });
        }
      }

      data.wired = Array.from(entryMap.values()).sort((a, b) => a.path.localeCompare(b.path));
      saveAllowlist(allowlistFile, data);
      console.log(`Updated wired allowlist in ${allowlistFile} (${data.wired.length} entries)`);
      process.exit(0);
    }

    const allowlist = loadAllowlist(allowlistFile);
    const status = workPackageStatus(progressFile);
    const { remaining: remWired, problems: probWired } = applyAllowlist("wired", wiredViolations, allowlist, status);

    let remDead = [];
    let probDead = [];
    if (allowlist.dead !== undefined) {
      const deadSymbols = analyzeDead({ root, entries, excludeDirs: [] });
      const deadViolations = deadSymbols.map((d) => ({
        rule: "dead-export",
        path: d.path,
        line: d.line,
        name: d.name,
        symbol: d.name,
      }));
      const res = applyAllowlist("dead", deadViolations, allowlist, status);
      remDead = res.remaining;
      probDead = res.problems;
    }

    const remaining = [...remWired, ...remDead];
    const problems = [...probWired, ...probDead];

    for (const v of remaining) {
      if (v.rule === "UNREACHABLE") {
        console.log(`${v.rule} ${v.path}:${v.line} ${v.message}`);
      } else {
        console.log(`${v.rule} ${v.path}:${v.line} ${v.name}`);
      }
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
    console.error(`Error running check-wired: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
