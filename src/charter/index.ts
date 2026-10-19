import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { currentVersion, readIndex } from "../archive/index.js";

function resolveSubstrateDir(dir: string): string {
  if (path.basename(dir) === ".substrate") {
    return dir;
  }
  const sub = path.join(dir, ".substrate");
  if (fs.existsSync(sub)) {
    return sub;
  }
  return dir;
}

/**
 * Reads .substrate/charter.md.
 * Returns undefined if the file does not exist.
 * Parses YAML frontmatter for `version` if present (^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$).
 * Body is the text without frontmatter.
 */
export function readCharter(
  substrateDir: string
): { body: string; version: string | undefined } | undefined {
  const base = resolveSubstrateDir(substrateDir);
  const charterPath = path.join(base, "charter.md");

  if (!fs.existsSync(charterPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(charterPath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (match) {
      let version: string | undefined;
      try {
        const parsed = YAML.parse(match[1]);
        if (parsed && typeof parsed === "object" && parsed.version !== undefined) {
          version = String(parsed.version).trim() || undefined;
        }
      } catch {
        // invalid frontmatter YAML leaves version undefined
      }
      return { body: match[2], version };
    }
    return { body: content, version: undefined };
  } catch {
    return undefined;
  }
}

/**
 * Returns the charter body, cut to 4096 bytes with marker [truncated], or (none) if missing/empty.
 * A charter of exactly 4096 bytes is not truncated.
 */
export function plannerCharter(substrateDir: string): string {
  const charter = readCharter(substrateDir);
  if (!charter || !charter.body.trim()) {
    return "(none)";
  }

  const buf = Buffer.from(charter.body, "utf8");
  if (buf.byteLength <= 4096) {
    return charter.body;
  }

  const marker = "\n[truncated]";
  const markerBuf = Buffer.from(marker, "utf8");
  const cutTarget = 4096 - markerBuf.byteLength;
  let text = buf.subarray(0, cutTarget).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > cutTarget) {
    text = text.slice(0, -1);
  }
  return text + marker;
}

/**
 * Returns the five most recent summaries of the current version (newest first in the INDEX sense:
 * the last five lines of INDEX.md, newest first), each run's summary.md, cut to 6144 bytes in total,
 * or (none) if missing or empty.
 * With historyAll: true, every version is included, newest version first (descending).
 * If a summary file is missing for an INDEX line, that run is skipped without error.
 */
export function plannerHistory(
  substrateDir: string,
  opts?: { historyAll?: boolean }
): string {
  const base = resolveSubstrateDir(substrateDir);
  const historyAll = Boolean(opts?.historyAll);

  let versions: string[] = [];
  if (historyAll) {
    const archiveDir = path.join(base, "archive");
    if (fs.existsSync(archiveDir)) {
      try {
        const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
        versions = entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      } catch {
        // on error versions remains empty
      }
    }
  } else {
    versions = [currentVersion(base)];
  }

  const summaries: string[] = [];
  for (const v of versions) {
    const records = readIndex(base, v);
    // last five lines of INDEX.md, newest first
    const recent = records.slice(-5).reverse();
    for (const rec of recent) {
      const summaryPath = path.join(rec.dir, "summary.md");
      if (fs.existsSync(summaryPath)) {
        try {
          const content = fs.readFileSync(summaryPath, "utf8").trim();
          if (content.length > 0) {
            summaries.push(content);
          }
        } catch {
          // skipped on read error
        }
      }
    }
  }

  if (summaries.length === 0) {
    return "(none)";
  }

  const combined = summaries.join("\n\n---\n\n");
  const buf = Buffer.from(combined, "utf8");
  if (buf.byteLength <= 6144) {
    return combined;
  }

  const marker = "\n[truncated]";
  const markerBuf = Buffer.from(marker, "utf8");
  const cutTarget = 6144 - markerBuf.byteLength;
  let text = buf.subarray(0, cutTarget).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > cutTarget) {
    text = text.slice(0, -1);
  }
  return text + marker;
}
