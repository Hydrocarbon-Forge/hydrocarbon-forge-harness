#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { findProjectRoot } from "./lib/scan.mjs";

function parseArgs(args) {
  let root = null;
  let allowlist = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = path.resolve(args[++i]);
    } else if (args[i] === "--allowlist" && i + 1 < args.length) {
      allowlist = path.resolve(args[++i]);
    }
  }

  const projRoot = root || findProjectRoot();
  return {
    root: projRoot,
    allowlistFile: allowlist || path.join(projRoot, "scripts/debt-allowlist.json"),
  };
}

export function runCheck(name, scriptPath, args, cwd) {
  const res = spawnSync("node", [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ok = res.status === 0;
  return {
    name,
    ok,
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

export async function main() {
  const { root, allowlistFile } = parseArgs(process.argv.slice(2));
  const scriptsDir = path.join(root, "scripts");

  const commonArgs = [
    "--root",
    root,
    "--allowlist",
    allowlistFile,
  ];

  const checks = [
    { name: "purity", script: path.join(scriptsDir, "check-purity.mjs"), args: commonArgs },
    { name: "wired", script: path.join(scriptsDir, "check-wired.mjs"), args: commonArgs },
    { name: "events", script: path.join(scriptsDir, "check-events.mjs"), args: commonArgs },
    { name: "settings", script: path.join(scriptsDir, "check-settings.mjs"), args: commonArgs },
    { name: "boundaries", script: path.join(scriptsDir, "check-boundaries.mjs"), args: [] },
    { name: "docs", script: path.join(scriptsDir, "docs-check.mjs"), args: [] },
  ];

  let anyFailed = false;

  for (const check of checks) {
    const res = runCheck(check.name, check.script, check.args, root);
    if (res.ok) {
      console.log(`${check.name}: OK`);
    } else {
      anyFailed = true;
      console.log(`${check.name}: FAIL (exit code ${res.status})`);
      if (res.stdout.trim()) {
        console.log(res.stdout.trim());
      }
      if (res.stderr.trim()) {
        console.error(res.stderr.trim());
      }
    }
  }

  if (anyFailed) {
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
