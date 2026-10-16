import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import { RunLock } from "../../../src/store/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "substrate-run-lock-"));
}

describe("store: RunLock acquire and release", () => {
  it("acquires lock when lock file does not exist, creating .substrate/state/<run_id>.lock", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lock = new RunLock(runId, { baseDir });

    const acquired = await lock.acquire();
    expect(acquired).toBe(true);

    const lockFile = join(baseDir, ".substrate", "state", `${runId}.lock`);
    expect(existsSync(lockFile)).toBe(true);

    const data = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.run_id).toBe(runId);
    expect(data.acquired_at).toBeDefined();
    expect(data.heartbeat_at).toBeDefined();
  });

  it("returns false when lock already held by an active process with fresh heartbeat", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lock1 = new RunLock(runId, { baseDir });
    const lock2 = new RunLock(runId, { baseDir });

    const acquired1 = await lock1.acquire();
    expect(acquired1).toBe(true);

    // Second acquire attempt by another instance
    const acquired2 = await lock2.acquire();
    expect(acquired2).toBe(false);
  });

  it("releases lock file when caller PID matches lock holder", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lock = new RunLock(runId, { baseDir });

    await lock.acquire();
    const lockFile = join(baseDir, ".substrate", "state", `${runId}.lock`);
    expect(existsSync(lockFile)).toBe(true);

    await lock.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("refuses to release a foreign lock held by another PID", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lockDir = join(baseDir, ".substrate", "state");
    mkdirSync(lockDir, { recursive: true });
    const lockFile = join(lockDir, `${runId}.lock`);

    // Simulate lock owned by another process
    const foreignPid = process.pid + 10000;
    const lockData = {
      pid: foreignPid,
      run_id: runId,
      acquired_at: nowIsoTimestamp(),
      heartbeat_at: nowIsoTimestamp(),
    };
    writeFileSync(lockFile, JSON.stringify(lockData));

    const lock = new RunLock(runId, { baseDir });
    await lock.release();

    // Lock file must still exist and still belong to foreign PID
    expect(existsSync(lockFile)).toBe(true);
    const after = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(after.pid).toBe(foreignPid);
  });
});

describe("store: RunLock stale detection, heartbeat, and reclamation", () => {
  it("updates heartbeat timestamp in lock file on heartbeat()", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lock = new RunLock(runId, { baseDir });

    await lock.acquire();
    const lockFile = join(baseDir, ".substrate", "state", `${runId}.lock`);
    const initial = JSON.parse(readFileSync(lockFile, "utf8"));

    // Artificially age the heartbeat
    const olderTime = new Date(Date.now() - 10000).toISOString();
    initial.heartbeat_at = olderTime;
    writeFileSync(lockFile, JSON.stringify(initial));

    await lock.heartbeat();
    const updated = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(new Date(updated.heartbeat_at).getTime()).toBeGreaterThan(new Date(olderTime).getTime());
  });

  it("reclaims lock when holder process is dead", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lockDir = join(baseDir, ".substrate", "state");
    mkdirSync(lockDir, { recursive: true });
    const lockFile = join(lockDir, `${runId}.lock`);

    // PID 9999999 is guaranteed non-existent on normal linux systems
    const deadPid = 9999999;
    const staleData = {
      pid: deadPid,
      run_id: runId,
      acquired_at: new Date(Date.now() - 60000).toISOString(),
      heartbeat_at: new Date(Date.now() - 60000).toISOString(),
    };
    writeFileSync(lockFile, JSON.stringify(staleData));

    const lock = new RunLock(runId, { baseDir, staleTimeoutMs: 10000 });
    const acquired = await lock.acquire();

    expect(acquired).toBe(true);
    const reclaimed = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(reclaimed.pid).toBe(process.pid);
  });

  it("reclaims lock when heartbeat exceeds stale timeout even if PID exists (PID reuse)", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lockDir = join(baseDir, ".substrate", "state");
    mkdirSync(lockDir, { recursive: true });
    const lockFile = join(lockDir, `${runId}.lock`);

    // Use PID 1 (systemd/init, always alive) to simulate an unrelated reused PID
    const reusedPid = 1;
    const staleHeartbeat = new Date(Date.now() - 100000).toISOString();
    const staleData = {
      pid: reusedPid,
      run_id: runId,
      acquired_at: new Date(Date.now() - 200000).toISOString(),
      heartbeat_at: staleHeartbeat,
    };
    writeFileSync(lockFile, JSON.stringify(staleData));

    const lock = new RunLock(runId, { baseDir, staleTimeoutMs: 5000 });
    const isStale = await lock.isStale();
    expect(isStale).toBe(true);

    const acquired = await lock.acquire();
    expect(acquired).toBe(true);

    const reclaimed = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(reclaimed.pid).toBe(process.pid);
  });

  it("isStale() returns false when lock heartbeat is fresh", async () => {
    const baseDir = tmp();
    const runId = createRunId();
    const lock = new RunLock(runId, { baseDir, staleTimeoutMs: 30000 });

    await lock.acquire();
    expect(await lock.isStale()).toBe(false);
  });
});
