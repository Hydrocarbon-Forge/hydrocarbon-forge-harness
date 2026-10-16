#!/usr/bin/env node
// Strict typecheck entry point (`npm run typecheck` delegates here).
// Fails clearly on Node below the supported minimum instead of continuing silently.
import { spawnSync } from "node:child_process";

const MIN_MAJOR = 22;
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < MIN_MAJOR) {
  console.error(
    `substrate typecheck: Node >= ${MIN_MAJOR} required (running on ${process.version}).`,
  );
  process.exit(1);
}

const res = spawnSync("npx", ["--no-install", "tsc", "--noEmit"], { stdio: "inherit" });
process.exit(res.status ?? 1);
