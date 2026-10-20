#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { findProjectRoot, listFiles, normalizeSlashes } from "./lib/scan.mjs";
import { loadAllowlist, saveAllowlist, applyAllowlist } from "./lib/allowlist.mjs";

/**
 * Unwraps Zod wrapper types: optional, nullable, default, effects.
 */
function unwrap(schema) {
  let cur = schema;
  while (cur) {
    const typeName = cur._def?.typeName;
    if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
      cur = cur._def.innerType;
    } else if (typeName === "ZodEffects") {
      cur = cur._def.schema;
    } else {
      break;
    }
  }
  return cur;
}

/**
 * Recursively walks a Zod schema to produce dotted leaf paths.
 */
export function extractLeafPaths(schema, prefix = "") {
  const unwrapped = unwrap(schema);
  if (!unwrapped || !unwrapped._def) return [];

  const typeName = unwrapped._def.typeName;
  const paths = [];

  if (typeName === "ZodObject") {
    const shape = typeof unwrapped.shape === "function" ? unwrapped.shape() : unwrapped.shape;
    for (const [key, val] of Object.entries(shape)) {
      const nextPath = prefix ? `${prefix}.${key}` : key;
      const unwrappedVal = unwrap(val);
      // Treat records of unknown/any as leaves (e.g. extra in backends.*.extra)
      if (
        unwrappedVal._def?.typeName === "ZodRecord" &&
        (unwrap(unwrappedVal._def.valueType)._def?.typeName === "ZodUnknown" ||
          unwrap(unwrappedVal._def.valueType)._def?.typeName === "ZodAny")
      ) {
        paths.push(nextPath);
      } else {
        paths.push(...extractLeafPaths(val, nextPath));
      }
    }
  } else if (typeName === "ZodRecord") {
    const val = unwrapped._def.valueType;
    const unwrappedVal = unwrap(val);
    if (unwrappedVal._def?.typeName === "ZodUnknown" || unwrappedVal._def?.typeName === "ZodAny") {
      if (prefix && !prefix.endsWith(".*")) {
        paths.push(prefix);
      }
    } else {
      const nextPath = prefix ? `${prefix}.*` : "*";
      paths.push(...extractLeafPaths(val, nextPath));
    }
  } else if (typeName === "ZodUnion" || typeName === "ZodDiscriminatedUnion") {
    const options = unwrapped._def.options;
    for (const opt of options) {
      paths.push(...extractLeafPaths(opt, prefix));
    }
  } else {
    // Primitive leaf
    if (prefix && !prefix.endsWith(".*")) {
      paths.push(prefix);
    }
  }

  return paths;
}

/**
 * Checks whether a dotted leaf path is read in the given file contents.
 */
function isLeafRead(leafPath, fileContents) {
  const parts = leafPath.split(".");
  const leaf = parts[parts.length - 1];
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;

  const bracketPatternDouble = `["${leaf}"]`;
  const bracketPatternSingle = `['${leaf}']`;
  const parentDot = parent && parent !== "*" ? `${parent}.${leaf}` : null;
  const parentOptDot = parent && parent !== "*" ? `${parent}?.${leaf}` : null;
  const topLevelRegex = !parent ? new RegExp(`\\b${leaf}\\??\\.`) : null;
  // A leaf under a wildcard record (pricing.models.*.input_per_mtok, routing.*.model) is read
  // through a value taken from the record (e.g. `rates.input_per_mtok`), so the parent name is
  // not in the text. Such a read counts when one file reads `.leaf` and also touches the
  // record's container (`.models`, `.routing`).
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const container = parent === "*" && parts.length >= 3 ? parts[parts.length - 3] : null;
  const wildcardLeafRegex = container ? new RegExp(`\\.${escapeRe(leaf)}\\b`) : null;
  const containerRegex = container ? new RegExp(`\\.${escapeRe(container)}\\b`) : null;

  for (const content of fileContents) {
    if (content.includes(bracketPatternDouble) || content.includes(bracketPatternSingle)) {
      return true;
    }
    if (parentDot && (content.includes(parentDot) || content.includes(parentOptDot))) {
      return true;
    }
    if (topLevelRegex && topLevelRegex.test(content)) {
      return true;
    }
    if (wildcardLeafRegex && wildcardLeafRegex.test(content) && containerRegex.test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Scans settings schema and source files to find unread settings keys.
 */
export async function scanSettings(root) {
  const contractsFile = path.resolve(root, "src/contracts/index.ts");
  if (!fs.existsSync(contractsFile)) {
    return [];
  }

  const tempOutfile = path.resolve(root, `.tmp_check_settings_${Date.now()}.mjs`);
  let Settings;

  try {
    await build({
      entryPoints: [contractsFile],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: tempOutfile,
      external: ["zod", "yaml"],
    });

    const contractsMod = await import(pathToFileURL(tempOutfile).href);
    Settings = contractsMod.Settings;
  } finally {
    if (fs.existsSync(tempOutfile)) {
      try {
        fs.unlinkSync(tempOutfile);
      } catch {
        // Ignore unlink error
      }
    }
  }

  if (!Settings) {
    throw new Error(`Export 'Settings' not found in ${contractsFile}`);
  }

  const allLeaves = [...new Set(extractLeafPaths(Settings))].sort();

  // Exclude: src/contracts/**, src/config/**, and src/cli/commands/config.ts
  const allSrcFiles = listFiles(root, "src", [".ts", ".js"]).filter((f) => {
    if (f.startsWith("src/contracts/")) return false;
    if (f.startsWith("src/config/")) return false;
    if (f === "src/cli/commands/config.ts") return false;
    return true;
  });

  const fileContents = allSrcFiles.map((f) => fs.readFileSync(path.resolve(root, f), "utf8"));

  const violations = [];
  for (const leafPath of allLeaves) {
    if (!isLeafRead(leafPath, fileContents)) {
      violations.push({
        rule: "unread-settings-key",
        key: leafPath,
        path: "src/contracts/index.ts",
        line: 1,
        message: `Settings key "${leafPath}" is not read anywhere in src/`,
      });
    }
  }

  return violations.sort((a, b) => a.key.localeCompare(b.key));
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
    const violations = await scanSettings(root);

    if (initAllowlist) {
      const data = loadAllowlist(allowlistFile);
      const existing = data.settings || [];
      const entryMap = new Map();
      for (const e of existing) {
        entryMap.set(e.key, e);
      }

      for (const v of violations) {
        if (!entryMap.has(v.key)) {
          entryMap.set(v.key, { key: v.key, until: "DEFERRED" });
        }
      }

      data.settings = Array.from(entryMap.values()).sort((a, b) => a.key.localeCompare(b.key));
      saveAllowlist(allowlistFile, data);
      console.log(`Updated settings allowlist in ${allowlistFile} (${data.settings.length} entries)`);
      process.exit(0);
    }

    const allowlist = loadAllowlist(allowlistFile);
    const { remaining, problems } = applyAllowlist("settings", violations, allowlist);

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
    console.error(`Error running check-settings: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
