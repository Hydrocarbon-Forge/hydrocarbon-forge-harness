#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot, listFiles, normalizeSlashes, importSpecifiers, resolveRelativeImport } from "./lib/scan.mjs";
import { loadAllowlist, saveAllowlist, applyAllowlist } from "./lib/allowlist.mjs";

const P2_FORBIDDEN_DIRS = [
  "src/engine",
  "src/backends",
  "src/roles",
  "src/git",
  "src/verify",
  "src/spec",
  "src/store",
  "src/ledger",
  "src/prompts",
  "src/util",
  "src/archive",
  "src/charter",
];

const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/;

/**
 * Masks single-line quoted strings with spaces to avoid false positives in string contents.
 * Limit: multiline string literals spanning across newlines are masked per-line.
 */
function maskQuotes(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => " ".repeat(m.length));
}

/**
 * Strips line comments starting with // from a line, ignoring // inside quotes.
 */
function stripLineComment(line) {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escape = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "/" && line[i + 1] === "/") {
        return line.slice(0, i);
      }
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === "`") inBacktick = true;
    } else if (inSingle && ch === "'") {
      inSingle = false;
    } else if (inDouble && ch === '"') {
      inDouble = false;
    } else if (inBacktick && ch === "`") {
      inBacktick = false;
    }
  }
  return line;
}

/**
 * Scans files for purity violations.
 * Returns sorted array of violations: { rule, path, line, message }.
 */
export function scanPurity(root) {
  const violations = [];
  const tsFiles = listFiles(root, "src", [".ts"]);

  for (const relPath of tsFiles) {
    const absPath = path.resolve(root, relPath);
    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split(/\r?\n/);

    // Rule P1: relative import whose resolved path is under test/ (or specifier contains /test/)
    const imports = importSpecifiers(content, relPath);
    for (const imp of imports) {
      const spec = imp.specifier;
      let isTestImport = false;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        if (spec.includes("/test/") || spec.startsWith("test/")) {
          isTestImport = true;
        } else {
          const resolved = resolveRelativeImport(relPath, spec, root);
          if (resolved && (resolved.startsWith("test/") || resolved.includes("/test/"))) {
            isTestImport = true;
          }
        }
      }
      if (isTestImport) {
        violations.push({
          rule: "P1",
          path: relPath,
          line: imp.line,
          message: `Relative import "${spec}" resolves to test/`,
        });
      }
    }

    // Rules P2 - P8 (and P9 for src)
    const isP2Area =
      P2_FORBIDDEN_DIRS.some((d) => relPath.startsWith(d + "/")) &&
      relPath !== "src/util/log.ts" &&
      !relPath.startsWith("src/cli/") &&
      !relPath.startsWith("src/tui/");

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const rawLine = lines[i];

      // P7: Fabricated edits (checked before stripping line comments because '// modified ${' starts with //)
      if (rawLine.includes("export const val_${") || rawLine.includes("// modified ${")) {
        violations.push({
          rule: "P7",
          path: relPath,
          line: lineNum,
          message: "Fabricated edit pattern is forbidden",
        });
      }

      // Strip // comments for remaining rules
      const stripped = stripLineComment(rawLine);
      const masked = maskQuotes(stripped);

      // P2: console., process.stdout.write, process.stderr.write
      if (isP2Area) {
        if (/\bconsole\./.test(masked) || /\bprocess\.std(?:out|err)\.write\b/.test(masked)) {
          violations.push({
            rule: "P2",
            path: relPath,
            line: lineNum,
            message: "console or process.std(out|err).write is forbidden in this area",
          });
        }
      }

      // P3: Stack sniffing
      if (
        rawLine.includes("new Error().stack") ||
        rawLine.includes(".stack?.includes") ||
        rawLine.includes(".stack.includes")
      ) {
        if (
          masked.includes("new Error().stack") ||
          masked.includes(".stack?.includes") ||
          masked.includes(".stack.includes")
        ) {
          violations.push({
            rule: "P3",
            path: relPath,
            line: lineNum,
            message: "Stack sniffing is forbidden",
          });
        }
      }

      // P4: Test sniffing
      if (
        /\bprocess\.env\.VITEST\b/.test(stripped) ||
        /\bprocess\.env\.JEST\b/.test(stripped) ||
        /\bprocess\.env\.NODE_ENV\s*===?\s*["'`]test["'`]/.test(stripped) ||
        /\bimport\.meta\.vitest\b/.test(stripped)
      ) {
        violations.push({
          rule: "P4",
          path: relPath,
          line: lineNum,
          message: "Test sniffing is forbidden",
        });
      }

      // P5: Magic strings
      if (
        stripped.includes('"First attempt done"') ||
        stripped.includes("'First attempt done'") ||
        stripped.includes("`First attempt done`") ||
        stripped.includes('"Attempt 1"') ||
        stripped.includes("'Attempt 1'") ||
        stripped.includes("`Attempt 1`") ||
        stripped.includes('"Attempt 2"') ||
        stripped.includes("'Attempt 2'") ||
        stripped.includes("`Attempt 2`") ||
        stripped.includes('"L2 contract amendment"') ||
        stripped.includes("'L2 contract amendment'") ||
        stripped.includes("`L2 contract amendment`")
      ) {
        violations.push({
          rule: "P5",
          path: relPath,
          line: lineNum,
          message: "Magic test string is forbidden",
        });
      }

      // P6: String literal starting with "You are the Substrate"
      if (/(["'`])You are the Substrate/.test(stripped)) {
        violations.push({
          rule: "P6",
          path: relPath,
          line: lineNum,
          message: 'String literal starting with "You are the Substrate" must live in assets/',
        });
      }

      // P8: Identifiers FakeAdapter or FAKE_SCENARIO
      if (/\bFakeAdapter\b/.test(stripped) || /\bFAKE_SCENARIO\b/.test(stripped)) {
        violations.push({
          rule: "P8",
          path: relPath,
          line: lineNum,
          message: "FakeAdapter or FAKE_SCENARIO is forbidden in src/",
        });
      }

      // P9: IPv4 address literal in src/
      if (IPV4_REGEX.test(stripped)) {
        violations.push({
          rule: "P9",
          path: relPath,
          line: lineNum,
          message: "IPv4 address literal is forbidden",
        });
      }
    }
  }

  // Rule P9 also scans assets/**
  const assetsDir = path.resolve(root, "assets");
  if (fs.existsSync(assetsDir)) {
    function walkAssets(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkAssets(full);
        } else if (entry.isFile()) {
          const rel = normalizeSlashes(path.relative(root, full));
          const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = stripLineComment(lines[i]);
            if (IPV4_REGEX.test(line)) {
              violations.push({
                rule: "P9",
                path: rel,
                line: i + 1,
                message: "IPv4 address literal is forbidden in assets/",
              });
            }
          }
        }
      }
    }
    walkAssets(assetsDir);
  }

  // Deterministic sorting: path then line
  return violations.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });
}

function parseArgs(args) {
  let root = null;
  let allowlist = null;
  let initAllowlist = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = path.resolve(args[++i]);
    } else if (args[i] === "--allowlist" && i + 1 < args.length) {
      allowlist = path.resolve(args[++i]);
    } else if (args[i] === "--init-allowlist") {
      initAllowlist = true;
    }
  }

  const projRoot = root || findProjectRoot();
  return {
    root: projRoot,
    allowlistFile: allowlist || path.join(projRoot, "scripts/debt-allowlist.json"),
    initAllowlist,
  };
}

export async function main() {
  try {
    const { root, allowlistFile, initAllowlist } = parseArgs(process.argv.slice(2));
    const violations = scanPurity(root);

    if (initAllowlist) {
      const data = loadAllowlist(allowlistFile);
      const existing = data.purity || [];
      const entryMap = new Map();
      for (const e of existing) {
        entryMap.set(`${e.rule}:${e.path}`, e);
      }

      for (const v of violations) {
        const key = `${v.rule}:${v.path}`;
        if (!entryMap.has(key)) {
          entryMap.set(key, { rule: v.rule, path: v.path, until: "DEFERRED" });
        }
      }

      data.purity = Array.from(entryMap.values()).sort((a, b) => {
        if (a.path !== b.path) return a.path.localeCompare(b.path);
        return a.rule.localeCompare(b.rule);
      });
      saveAllowlist(allowlistFile, data);
      console.log(`Updated purity allowlist in ${allowlistFile} (${data.purity.length} entries)`);
      process.exit(0);
    }

    const allowlist = loadAllowlist(allowlistFile);
    const { remaining, problems } = applyAllowlist("purity", violations, allowlist);

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
    console.error(`Error running check-purity: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
