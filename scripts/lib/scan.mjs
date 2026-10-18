import fs from "node:fs";
import path from "node:path";

/**
 * Finds the project root directory by walking up from startDir
 * until package.json is found.
 */
export function findProjectRoot(startDir = process.cwd()) {
  let cur = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(cur, "package.json"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir);
}

/**
 * Normalizes a path to forward slashes.
 */
export function normalizeSlashes(p) {
  return p.split(path.sep).join("/");
}

/**
 * Collects files recursively under root/relDir matching extensions.
 * Excludes .d.ts files when matching .ts.
 * Returns sorted repo-relative paths with forward slashes.
 */
export function listFiles(root, relDir = "", extensions = [".ts"]) {
  const baseDir = path.resolve(root, relDir);
  if (!fs.existsSync(baseDir)) return [];

  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const matchesExt = extensions.some((ext) => full.endsWith(ext));
        if (matchesExt) {
          // Exclude declaration files unless specifically requested
          if (full.endsWith(".d.ts") && !extensions.includes(".d.ts")) {
            continue;
          }
          const rel = normalizeSlashes(path.relative(root, full));
          results.push(rel);
        }
      }
    }
  }

  walk(baseDir);
  return results.sort();
}

/**
 * Reads all lines of a file.
 */
export function readLines(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

/**
 * Sanitizes TypeScript/JavaScript code by replacing line/block comments
 * with spaces to preserve exact line numbers and byte offsets.
 */
function maskComments(text) {
  // Replace /* ... */ preserving line breaks
  let sanitized = text.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\r\n]/g, " ");
  });
  // Replace // comments up to newline
  sanitized = sanitized.replace(/\/\/[^\r\n]*/g, (match) => {
    return " ".repeat(match.length);
  });
  return sanitized;
}

/**
 * Extracts import and export specifiers from text.
 * Handles:
 * - import ... from "x"
 * - import "x"
 * - export ... from "x"
 * - import("x")
 * - import(`./x.js`) (backtick without interpolation)
 * If dynamic import contains ${...}, ignores it and warns if filePath provided.
 *
 * Returns { specifier: string, line: number }[]
 */
export function importSpecifiers(text, filePath = "") {
  const sanitized = maskComments(text);
  const results = [];

  // 1. Static imports:
  // import ... from "spec" or import "spec"
  // (handles multiline import { ... } from "spec", import type, etc.)
  const staticImportRe = /\bimport\s+(?:(?:type\s+)?[\w*\s{},$]+\s+from\s+)?['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = staticImportRe.exec(sanitized)) !== null) {
    const spec = m[1];
    const line = sanitized.slice(0, m.index).split("\n").length;
    results.push({ specifier: spec, line });
  }

  // 2. Static exports:
  // export ... from "spec"
  const staticExportRe = /\bexport\s+(?:type\s+)?(?:[\w*\s{},$]+\s+from\s+)['"`]([^'"`]+)['"`]/g;
  while ((m = staticExportRe.exec(sanitized)) !== null) {
    const spec = m[1];
    const line = sanitized.slice(0, m.index).split("\n").length;
    results.push({ specifier: spec, line });
  }

  // 3. Dynamic imports:
  // import("spec") or import(`spec`)
  const dynamicImportRe = /\bimport\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/g;
  while ((m = dynamicImportRe.exec(sanitized)) !== null) {
    const quote = m[1];
    const rawContent = m[2];
    if (quote === "`" && rawContent.includes("${")) {
      if (filePath) {
        console.warn(`Warning: dynamic import with interpolation in ${filePath} cannot be resolved`);
      }
      continue;
    }
    const spec = rawContent.trim();
    if (spec) {
      const line = sanitized.slice(0, m.index).split("\n").length;
      results.push({ specifier: spec, line });
    }
  }

  return results;
}

/**
 * Resolves a relative import specifier to a repo-relative path.
 * Maps ./x.js to ./x.ts, or ./x/index.ts.
 * Returns null for non-relative specifiers or unresolvable targets.
 */
export function resolveRelativeImport(fromFile, specifier, root) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }

  const absFrom = path.isAbsolute(fromFile) ? fromFile : path.resolve(root, fromFile);
  const fromDir = path.dirname(absFrom);
  const absTarget = path.resolve(fromDir, specifier);

  const candidates = [];

  if (specifier.endsWith(".js")) {
    const noJs = absTarget.slice(0, -3);
    candidates.push(noJs + ".ts");
    candidates.push(noJs + ".tsx");
    candidates.push(path.join(noJs, "index.ts"));
    candidates.push(absTarget); // in case .js actually exists
  } else if (specifier.endsWith(".ts") || specifier.endsWith(".tsx")) {
    candidates.push(absTarget);
  } else {
    candidates.push(absTarget + ".ts");
    candidates.push(absTarget + ".tsx");
    candidates.push(path.join(absTarget, "index.ts"));
    candidates.push(absTarget);
  }

  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return normalizeSlashes(path.relative(root, cand));
      }
    } catch {
      // Continue searching
    }
  }

  return null;
}
