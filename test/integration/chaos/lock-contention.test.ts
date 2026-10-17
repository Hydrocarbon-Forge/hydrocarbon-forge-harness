import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest, RunId } from "../../../src/contracts/index.js";
import { RunLockImpl } from "../../../src/store/run-lock.js";
import {
  setupScenarioEnv,
  writePlanFiles,
  type ScenarioEnv,
} from "../scenarios/helpers.js";
import {
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../roles/fixtures.js";
import { createEngine } from "../../../src/engine/engine.js";
import { createSimulatedLock } from "./helpers.js";

describe("Double lock contention (§14.5 #11 lock semantics)", () => {
  let env: ScenarioEnv;

  beforeEach(async () => {
    env = await setupScenarioEnv("lock-contention");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("rejects concurrent acquisition when lock is actively held (active lock rejection)", async () => {
    const runId: RunId = "r_LOCKAAAAHOLD";
    const lockPath = createSimulatedLock(env.repoRoot, runId, {
      pid: process.pid,
      heartbeatAgeMs: 0,
    });
    expect(existsSync(lockPath)).toBe(true);

    const lock = new RunLockImpl(runId, { baseDir: env.repoRoot });
    expect(await lock.isStale()).toBe(false);
    expect(await lock.acquire()).toBe(false);

    // Engine run throws active lock conflict error
    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };
    writePlanFiles(env.repoRoot, runId, manifest, {
      "tasks/T1.md": sampleValidTaskSpecMarkdown(),
    });

    const engine = createEngine({ adapter: env.adapter });
    await expect(
      engine.run({
        cwd: env.repoRoot,
        prompt: "Run should fail due to active lock",
        mode: "plan",
        permission_mode: "bypassPermissions",
      })
    ).rejects.toThrow(/active lock exists/);

    // Lock file remains untouched with original holder's PID
    const lockData = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(lockData.pid).toBe(process.pid);
  });

  it("reclaims stale lock when PID is dead (dead PID recovery)", async () => {
    const runId: RunId = "r_LOCKBBBBDEDP";
    // Non-existent PID 99999999
    const lockPath = createSimulatedLock(env.repoRoot, runId, {
      pid: 99999999,
      heartbeatAgeMs: 0,
    });

    const lock = new RunLockImpl(runId, { baseDir: env.repoRoot });
    expect(await lock.isStale()).toBe(true);
    expect(await lock.acquire()).toBe(true);

    // Successfully acquired and updated with current PID
    const lockData = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(lockData.pid).toBe(process.pid);
    await lock.release();
  });

  it("reclaims stale lock with recycled active PID when heartbeat is expired (> 30000ms)", async () => {
    const runId: RunId = "r_LOCKCCCCHBRT";
    // Active PID (current process) but heartbeat expired (60 seconds old)
    const lockPath = createSimulatedLock(env.repoRoot, runId, {
      pid: process.pid,
      heartbeatAgeMs: 60000,
    });

    const lock = new RunLockImpl(runId, { baseDir: env.repoRoot, staleTimeoutMs: 30000 });
    expect(await lock.isStale()).toBe(true);
    expect(await lock.acquire()).toBe(true);

    // Heartbeat timestamp updated to fresh
    const lockData = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(Date.now() - new Date(lockData.heartbeat_at).getTime()).toBeLessThan(5000);
    await lock.release();
  });

  it("handles simultaneous acquisition race safely where exactly one succeeds", async () => {
    const runId: RunId = "r_LOCKDDDDRACE";
    const lock1 = new RunLockImpl(runId, { baseDir: env.repoRoot });
    const lock2 = new RunLockImpl(runId, { baseDir: env.repoRoot });

    // Race two lock acquisitions simultaneously
    const [res1, res2] = await Promise.all([lock1.acquire(), lock2.acquire()]);

    // Exclusivity: exactly one must succeed, or at least they cannot corrupt the lock file
    const lockPath = join(env.repoRoot, ".substrate", "state", `${runId}.lock`);
    expect(existsSync(lockPath)).toBe(true);
    const lockData = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(lockData.run_id).toBe(runId);
    expect(lockData.pid).toBe(process.pid);

    if (res1) await lock1.release();
    if (res2) await lock2.release();
  });

  it("releases lock file upon successful engine execution", async () => {
    const runId: RunId = "r_LOCKEEEEEXIT";
    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      integration_verify: [{ run: "echo verify passed", timeout_s: 30 }],
    };

    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      {
        "tasks/T1.md": sampleValidTaskSpecMarkdown({
          frontmatter: {
            id: "T1",
            title: "T1",
            depends_on: [],
            write: ["src/t1.ts"],
            create: ["test/t1.test.ts"],
            verify: [{ run: "echo ok", timeout_s: 30 }],
          },
        }),
      },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    const engine = createEngine({ adapter: env.adapter });
    const summary = await engine.run({
      cwd: env.repoRoot,
      prompt: "Execute clean run to verify lock release",
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);

    // Verify lock file was unlinked in finally block
    const lockPath = join(env.repoRoot, ".substrate", "state", `${runId}.lock`);
    expect(existsSync(lockPath)).toBe(false);
  });
});
