import fs from "node:fs";
import path from "node:path";

/**
 * Reads and parses a scenario JSON file.
 * Exits with code 3 if the path is unset, not found, or invalid.
 *
 * @param {string | undefined} file
 * @returns {Record<string, any>}
 */
export function readScenario(file) {
  if (!file) {
    process.stderr.write("fake-harness: FAKE_SCENARIO_FILE not set\n");
    process.exit(3);
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`fake-harness: FAKE_SCENARIO_FILE not found: ${file}\n`);
    process.exit(3);
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`fake-harness: failed to parse scenario file ${file}: ${err.message}\n`);
    process.exit(3);
  }
}

/**
 * Consumes the next call in the scenario file using an atomic counter state file.
 * Exits with code 3 if scenario or state is missing/exhausted.
 *
 * @param {string | undefined} file
 * @returns {{ call: Record<string, any>, index: number }}
 */
export function takeCall(file) {
  const scenario = readScenario(file);
  const stateFile = `${file}.state.json`;
  let next = 0;

  if (fs.existsSync(stateFile)) {
    try {
      const stateContent = fs.readFileSync(stateFile, "utf8");
      const state = JSON.parse(stateContent);
      if (typeof state.next === "number") {
        next = state.next;
      }
    } catch {
      next = 0;
    }
  }

  const calls = Array.isArray(scenario.calls) ? scenario.calls : [];
  if (next >= calls.length) {
    process.stderr.write(`fake-harness: scenario has no call ${next}\n`);
    process.exit(3);
  }

  const call = calls[next];
  fs.writeFileSync(stateFile, JSON.stringify({ next: next + 1 }), "utf8");
  return { call, index: next };
}

/**
 * Validates that a path is relative and does not contain `..` segments.
 * Exits with code 3 on unsafe path.
 *
 * @param {string} targetPath
 */
function checkSafePath(targetPath) {
  if (
    path.isAbsolute(targetPath) ||
    targetPath.startsWith("/") ||
    targetPath.startsWith("\\") ||
    /^[a-zA-Z]:/.test(targetPath)
  ) {
    process.stderr.write(`fake-harness: unsafe path ${targetPath}\n`);
    process.exit(3);
  }
  const parts = targetPath.split(/[/\\]/);
  if (parts.includes("..")) {
    process.stderr.write(`fake-harness: unsafe path ${targetPath}\n`);
    process.exit(3);
  }
}

/**
 * Applies the edits, appends, and plan files specified by the call.
 *
 * @param {Record<string, any>} call
 * @param {string} [cwd]
 */
export function applyCall(call, cwd = process.cwd()) {
  if (!call) return;

  // 1. plan.files is written into the process cwd before any other step
  if (call.plan && call.plan.files) {
    for (const [relPath, content] of Object.entries(call.plan.files)) {
      checkSafePath(relPath);
      const full = path.resolve(cwd, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(content), "utf8");
    }
  }

  // 2. edits
  if (call.edits) {
    for (const [relPath, content] of Object.entries(call.edits)) {
      checkSafePath(relPath);
      const full = path.resolve(cwd, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(content), "utf8");
    }
  }

  // 3. append
  if (call.append) {
    for (const [relPath, content] of Object.entries(call.append)) {
      checkSafePath(relPath);
      const full = path.resolve(cwd, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, String(content), "utf8");
    }
  }
}
