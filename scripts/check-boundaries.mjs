#!/usr/bin/env node
// Enforces SUBSTRATE-PLAN.md §15 import boundaries:
//
// - `contracts` and `util` import nothing internal except each other.
// - `backends` imports only `contracts`, `util`.
// - `engine` may import everything except `cli|hooks`.
// - Nothing imports `cli`.
//
// Scans `src/**/*.ts`, resolves relative imports to the top-level area
// (first path segment under `src/`), and reports violations.
// Exit 0 when clean, non-zero on violation.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcDir = join(root, "src");

const SURFACE_FORBIDDEN = new Set(["cli"]);
const ENGINE_FORBIDDEN = new Set(["cli", "hooks"]);

/** Collect all .ts files under a directory (recursive). */
function collectTsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (st.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Top-level area of a file under src (e.g. src/engine/foo.ts -> "engine"). Null for src root files. */
function areaOfFile(absPath) {
  const rel = absPath.slice(srcDir.length + 1).split(sep).join("/");
  const [first, ...rest] = rel.split("/");
  if (rest.length === 0) return null; // src/<file>.ts — the package root, no area
  return first;
}

/** Extract raw module specifiers from static/dynamic imports and re-exports. */
function extractSpecifiers(source) {
  const specs = [];
  const patterns = [
    // import ... from "spec" | import "spec"
    /(?:^|;|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    // export ... from "spec"
    /(?:^|;|\n)\s*export\s+(?:[^'"]*?\sfrom\s+)['"]([^'"]+)['"]/g,
    // import("spec")
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

/** Resolve a specifier to a top-level src area, or null if external/builtin. */
function specifierToArea(spec, importerAbs) {
  if (!spec.startsWith(".") && !spec.startsWith("src/") && !spec.startsWith("@/")) {
    // Bare specifier (npm dep, node: builtin, etc.) — not an internal import.
    // Treat `src/<area>/...` absolute-style imports as internal too.
    return null;
  }
  let targetArea = null;
  if (spec.startsWith("src/")) {
    targetArea = spec.split("/")[1] ?? null;
  } else if (spec.startsWith("@/")) {
    targetArea = spec.split("/")[1] ?? null;
  } else {
    // Relative: resolve against the importer, then map back under src/.
    const resolved = resolve(dirname(importerAbs), spec);
    const withExt = resolved.endsWith(".ts") ? resolved : resolved + ".ts";
    const candidates = [resolved, withExt, join(resolved, "index.ts")];
    let rel = null;
    for (const c of candidates) {
      if (c === srcDir || c.startsWith(srcDir + sep)) {
        rel = c.slice(srcDir.length + 1).split(sep).join("/");
        break;
      }
    }
    if (rel === null) return null; // resolves outside src/ — not an internal area import
    const [first, ...rest] = rel.split("/");
    targetArea = rest.length === 0 ? null : first; // src root target has no area
  }
  return targetArea;
}

function allowedTargets(importerArea) {
  if (importerArea === "contracts" || importerArea === "util") {
    return new Set(["contracts", "util"]);
  }
  if (importerArea === "backends") {
    return new Set(["contracts", "util"]);
  }
  return null; // no allowlist (only the global cli ban + engine ban apply)
}

function main() {
  const files = collectTsFiles(srcDir);
  const violations = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const importerArea = areaOfFile(file);
    const rel = file.slice(root.length + 1).split(sep).join("/");
    const allowlist = importerArea === null ? null : allowedTargets(importerArea);

    for (const spec of extractSpecifiers(source)) {
      const target = specifierToArea(spec, file);
      if (target === null) continue; // external or src-root target — no boundary applies

      // Global rule: nothing imports cli.
      if (SURFACE_FORBIDDEN.has(target)) {
        violations.push(`${rel} imports internal area "${target}" (nothing may import cli)`);
        continue;
      }
      // Engine rule: engine may import everything except cli|hooks.
      if (importerArea === "engine" && ENGINE_FORBIDDEN.has(target)) {
        violations.push(`${rel} imports internal area "${target}" (engine may not import cli|hooks)`);
        continue;
      }
      // Allowlist rules for contracts/util/backends.
      if (allowlist !== null && !allowlist.has(target) && target !== importerArea) {
        const who =
          importerArea === "backends"
            ? "backends may import only contracts, util"
            : `${importerArea} may import nothing internal except contracts, util`;
        violations.push(`${rel} imports internal area "${target}" (${who})`);
      }
    }
  }

  if (violations.length > 0) {
    console.error("Import boundary violations (§15):");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`Boundaries OK (§15): checked ${files.length} file(s) under src/.`);
}

main();
