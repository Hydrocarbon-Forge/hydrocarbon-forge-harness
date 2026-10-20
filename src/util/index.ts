import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Generate a 12-char base32 uppercase string prefixed with r_ */
export function createRunId(): string {
  const bytes = crypto.randomBytes(12);
  let id = "r_";
  for (let i = 0; i < 12; i++) {
    id += BASE32_ALPHABET[bytes[i] % 32];
  }
  return id;
}

export function isSafePath(root: string, relPath: string): boolean {
  if (typeof root !== "string" || typeof relPath !== "string") return false;
  if (!relPath || relPath.includes("\0")) return false;
  if (path.isAbsolute(relPath)) return false;

  const segments = relPath.split(/[/\\]/);
  if (segments.includes("..")) return false;

  const normalized = path.normalize(relPath);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("..\\") ||
    path.isAbsolute(normalized)
  ) {
    return false;
  }

  const fullPath = path.resolve(root, relPath);
  const relFromRoot = path.relative(root, fullPath);
  if (
    relFromRoot === ".." ||
    relFromRoot.startsWith("../") ||
    relFromRoot.startsWith("..\\") ||
    path.isAbsolute(relFromRoot)
  ) {
    return false;
  }

  // Symlink checks: walk up to the deepest existing ancestor
  try {
    let cur = fullPath;
    while (!fs.existsSync(cur)) {
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    if (fs.existsSync(cur) && fs.existsSync(root)) {
      const realCur = fs.realpathSync(cur);
      const realRoot = fs.realpathSync(root);
      const r = path.relative(realRoot, realCur);
      if (r === ".." || r.startsWith("../") || r.startsWith("..\\") || path.isAbsolute(r)) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

export function matchGlob(pattern: string, text: string): boolean {
  if (typeof pattern !== "string" || typeof text !== "string" || !pattern) return false;
  try {
    const mPat = pattern.match(/^([A-Za-z0-9_]+)\((.*)\)$/);
    if (mPat) {
      const mText = text.match(/^([A-Za-z0-9_]+)\((.*)\)$/);
      if (mText && mPat[1] === mText[1]) {
        return matchGlob(mPat[2], mText[2]);
      }
      return false;
    }
    const isMatch = picomatch(pattern, { dot: false });
    return isMatch(text);
  } catch {
    return false;
  }
}

export const HEAL_TAIL_MAX_BYTES = 8192;

export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (typeof maxBytes !== "number" || maxBytes <= 0 || !Number.isFinite(maxBytes)) {
    throw new Error(`Invalid byte cap: ${maxBytes}`);
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  const sliced = buf.subarray(buf.byteLength - maxBytes);
  let out = sliced.toString("utf8");
  while (Buffer.byteLength(out) > maxBytes) {
    out = out.slice(1);
  }
  return { text: out, truncated: true };
}

export function takeTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  return capBytes(text, maxBytes);
}

const SECRET_PATTERNS = [
  /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9_]{36,255}/g,
  /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g,
];

// Keyed secrets keep their label so the reader can still see what was masked.
const LABELLED_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/(\bapi[_-]?key["']?\s*[=:]\s*["']?)[^\s"',;]+/gi, "$1[REDACTED]"],
];

export function redactSecrets(text: string, extraSecrets?: string[]): string {
  if (typeof text !== "string") return String(text ?? "");
  let result = text;
  for (const re of SECRET_PATTERNS) {
    result = result.replace(re, "[REDACTED]");
  }
  for (const [re, replacement] of LABELLED_SECRET_PATTERNS) {
    result = result.replace(re, replacement);
  }
  if (Array.isArray(extraSecrets)) {
    for (const secret of extraSecrets) {
      if (typeof secret === "string" && secret.length > 0) {
        result = result.replaceAll(secret, "[REDACTED]");
      }
    }
  }
  return result;
}

/** Longest free-text message an event may carry (task.failed.message). */
const MESSAGE_MAX_CHARS = 2000;

/** One line, trimmed, at most MESSAGE_MAX_CHARS characters. */
export function boundedMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MESSAGE_MAX_CHARS ? oneLine.slice(0, MESSAGE_MAX_CHARS) : oneLine;
}

export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}
