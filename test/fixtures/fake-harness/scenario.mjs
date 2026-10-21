import fs from "node:fs";
import path from "node:path";

/**
 * The task a worker serves, read from its worktree name (<task>-g<generation>). The planner runs in
 * the repository itself and gets undefined.
 *
 * @param {string} cwd
 * @returns {string | undefined}
 */
export function taskKeyFromCwd(cwd) {
  const match = path.basename(cwd).match(/^(.+)-g\d+$/);
  return match ? match[1] : undefined;
}

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
 * Consumes one call of the scenario file and returns it with its index. Calls are consumed once
 * each, under an exclusive lock (a directory created with mkdir), so two harness processes that
 * start together never take the same call (R8.3: workers run side by side).
 *
 * A call with a `task` key belongs to that task: the worker of task `taskKey` takes the first
 * unused call tagged with its id. Any other caller, and a worker with no tagged call left, takes the
 * first unused untagged call, which is the positional order the scenarios always used. Exits with
 * code 3 if the scenario or the state is missing or exhausted.
 *
 * @param {string | undefined} file
 * @param {string | undefined} [taskKey]
 * @returns {{ call: Record<string, any>, index: number }}
 */
export function takeCall(file, taskKey) {
  const scenario = readScenario(file);
  const stateFile = `${file}.state.json`;
  const lockDir = `${file}.lock`;
  const calls = Array.isArray(scenario.calls) ? scenario.calls : [];

  // Exits are taken after the lock is released: process.exit would skip a finally block.
  let outcome;
  try {
    acquireLock(lockDir);
    try {
      outcome = { taken: claimCall(calls, stateFile, taskKey) };
    } finally {
      fs.rmdirSync(lockDir);
    }
  } catch (err) {
    outcome = { missing: err };
  }
  if (outcome.missing) {
    process.stderr.write(`${outcome.missing.message}\n`);
    process.exit(3);
  }
  return outcome.taken;
}

/** Takes the directory lock, waiting for a holder for up to 30 s; a lock older than 10 s is stale. */
function acquireLock(lockDir) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 10000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`fake-harness: could not lock ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/** Picks and records the call for this process; throws when none is left. */
function claimCall(calls, stateFile, taskKey) {
  // The state is { next } while the calls taken are the first `next`; a call taken out of order
  // (a tagged call) also records the list of indexes taken, in `used`.
  let used = new Set();
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (Array.isArray(state.used)) used = new Set(state.used);
      else if (typeof state.next === "number") {
        for (let i = 0; i < state.next; i++) used.add(i);
      }
    } catch {
      used = new Set();
    }
  }

  let index = -1;
  if (taskKey !== undefined) {
    index = calls.findIndex((c, i) => !used.has(i) && c?.task === taskKey);
  }
  if (index < 0) {
    index = calls.findIndex((c, i) => !used.has(i) && c?.task === undefined);
  }
  if (index < 0) {
    throw new Error(
      taskKey === undefined
        ? `fake-harness: scenario has no call ${used.size}`
        : `fake-harness: scenario has no call for ${taskKey}`
    );
  }

  used.add(index);
  const taken = [...used].sort((a, b) => a - b);
  const contiguous = taken.every((value, i) => value === i);
  fs.writeFileSync(stateFile, JSON.stringify(contiguous ? { next: taken.length } : { next: taken.length, used: taken }), "utf8");
  return { call: calls[index], index };
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

  // 4. remove: the listed files are deleted (a repair that deletes a test file, R12.4)
  if (call.remove) {
    for (const relPath of call.remove) {
      checkSafePath(relPath);
      fs.rmSync(path.resolve(cwd, relPath), { force: true });
    }
  }
}
