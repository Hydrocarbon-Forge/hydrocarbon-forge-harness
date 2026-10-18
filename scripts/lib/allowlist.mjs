import fs from "node:fs";
import path from "node:path";

/**
 * Loads debt allowlist from a JSON file.
 * Returns default empty structure if file does not exist.
 */
export function loadAllowlist(file) {
  if (!fs.existsSync(file)) {
    return {
      purity: [],
      wired: [],
      events: [],
      events_observe_only: [],
      settings: [],
    };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    return {
      purity: Array.isArray(data.purity) ? data.purity : [],
      wired: Array.isArray(data.wired) ? data.wired : [],
      events: Array.isArray(data.events) ? data.events : [],
      events_observe_only: Array.isArray(data.events_observe_only) ? data.events_observe_only : [],
      settings: Array.isArray(data.settings) ? data.settings : [],
      ...(Array.isArray(data.dead) ? { dead: data.dead } : {}),
    };
  } catch (err) {
    throw new Error(`Failed to read allowlist file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Saves debt allowlist to a JSON file.
 */
export function saveAllowlist(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const formatted = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(file, formatted, "utf8");
}

/**
 * Parses docs/plan/PROGRESS.md rows to extract work package status.
 * Returns a Map<id, status>.
 * If progressFile does not exist, warns and returns a map defaulting to "TODO".
 */
export function workPackageStatus(progressFile) {
  const map = new Map();
  if (!fs.existsSync(progressFile)) {
    console.warn(`Warning: PROGRESS file not found at ${progressFile}; treating all work packages as TODO`);
    return {
      get: () => "TODO",
      has: () => true,
    };
  }

  const content = fs.readFileSync(progressFile, "utf8");
  for (const line of content.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length >= 5 && /^R\d+\.\d+$/.test(cells[0])) {
      const id = cells[0];
      const status = cells[4];
      map.set(id, status);
    }
  }

  return map;
}

/**
 * Checks if an allowlist entry matches a violation.
 */
export function matchesEntry(kind, entry, violation) {
  if (kind === "purity") {
    return entry.rule === violation.rule && entry.path === violation.path;
  }
  if (kind === "wired") {
    if (entry.path.endsWith("/**")) {
      const prefix = entry.path.slice(0, -3);
      return violation.path === prefix || violation.path.startsWith(prefix + "/");
    }
    return entry.path === violation.path;
  }
  if (kind === "events") {
    return entry.type === violation.type && entry.kind === violation.kind;
  }
  if (kind === "settings") {
    if (entry.key.endsWith(".*")) {
      const prefix = entry.key.slice(0, -1);
      return violation.key.startsWith(prefix);
    }
    return entry.key === violation.key;
  }
  if (kind === "dead") {
    return entry.symbol === violation.symbol && entry.path === violation.path;
  }
  return false;
}

/**
 * Applies the debt allowlist to violations of a given kind.
 *
 * Rules:
 * 1. A violation that matches an allowlist entry is suppressed.
 * 2. An allowlist entry that matches no violation is a stale entry ("remove it").
 * 3. If an entry's `until` work package has Status DONE in PROGRESS.md, the entry fails
 *    the check ("debt of finished WP still present"). DEFERRED entries are exempt.
 * 4. `until` must match ^R\d+\.\d+$ or equal DEFERRED; anything else is an error.
 *
 * Returns: { remaining: Violation[], problems: string[] }
 */
export function applyAllowlist(kind, violations, allowlist, status) {
  const entries = (allowlist && allowlist[kind]) || [];
  const problems = [];

  for (const entry of entries) {
    const until = entry.until;

    // Rule 4: validate until
    if (until !== "DEFERRED" && !/^R\d+\.\d+$/.test(until ?? "")) {
      problems.push(`Invalid 'until' in allowlist entry: "${until}"`);
      continue;
    }

    // Rule 3: check if until WP is DONE
    if (until !== "DEFERRED") {
      const wpStatus = status instanceof Map ? status.get(until) : status?.get ? status.get(until) : status?.[until];
      if (wpStatus === "DONE") {
        problems.push(`Debt of finished WP ${until} still present in ${kind} allowlist: ${JSON.stringify(entry)}`);
      }
    }

    // Rule 2: stale entry check
    const matchCount = violations.filter((v) => matchesEntry(kind, entry, v)).length;
    if (matchCount === 0) {
      problems.push(`Stale allowlist entry in ${kind} (matches nothing): ${JSON.stringify(entry)}`);
    }
  }

  // Rule 1: suppress matched violations
  const remaining = violations.filter((v) => {
    return !entries.some((entry) => matchesEntry(kind, entry, v));
  });

  return { remaining, problems };
}
