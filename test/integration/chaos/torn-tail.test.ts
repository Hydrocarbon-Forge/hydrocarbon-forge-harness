import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest, RunId } from "../../../src/contracts/index.js";
import { EventStoreImpl } from "../../../src/store/event-store.js";
import {
  setupScenarioEnv,
  writePlanFiles,
  readEventLog,
  type ScenarioEnv,
} from "../scenarios/helpers.js";
import {
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../roles/fixtures.js";
import {
  runUntilBoundaryAndCrash,
  resumeAfterCrash,
  corruptEventLogTail,
} from "./helpers.js";

describe("Torn-tail event log recovery (§14.5 #11 edge case)", () => {
  let env: ScenarioEnv;

  beforeEach(async () => {
    env = await setupScenarioEnv("torn-tail");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("recovers from truncated JSON at event log tail and completes run", async () => {
    const runId: RunId = "r_TORNAAAAJSON";

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      integration_verify: [{ run: "echo verify ok", timeout_s: 30 }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Task 1",
        depends_on: [],
        write: ["src/t1.ts"],
        create: ["test/t1.test.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": t1Spec },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    // Run until event 5 (plan.produced) and crash
    const crashInfo = await runUntilBoundaryAndCrash(
      {
        cwd: env.repoRoot,
        prompt: "Execute torn tail test",
        mode: "plan",
        permission_mode: "bypassPermissions",
        adapter: env.adapter,
      },
      5
    );

    expect(crashInfo.crashedSeq).toBe(5);

    const eventsBefore = readEventLog(env.runDir, runId);
    expect(eventsBefore.length).toBe(5);

    // Simulate torn-tail: append truncated JSON line
    corruptEventLogTail(crashInfo.runDir, "truncated_json");

    // EventStoreImpl.readAll drops the trailing truncated line and recovers valid prefix
    const store = new EventStoreImpl(runId, { baseDir: env.repoRoot });
    const recoveredEvents = await store.readAll();
    expect(recoveredEvents.length).toBe(5);
    expect(recoveredEvents[recoveredEvents.length - 1].seq).toBe(5);

    // Resume execution to completion
    const summary = await resumeAfterCrash(runId, {
      cwd: env.repoRoot,
      adapter: env.adapter,
    });

    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
    expect(summary.tasks.T1?.state).toBe("PASSED");

    // Verify final event log sequence monotonicity without syntax errors
    const finalEvents = readEventLog(env.runDir, runId);
    expect(finalEvents.length).toBeGreaterThan(5);
    for (let i = 0; i < finalEvents.length; i++) {
      expect(finalEvents[i].seq).toBe(i + 1);
    }
  });

  it("recovers from garbage bytes at event log tail and completes run", async () => {
    const runId: RunId = "r_TORNBBBBGARB";

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      integration_verify: [{ run: "echo verify ok", timeout_s: 30 }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Task 1",
        depends_on: [],
        write: ["src/t1.ts"],
        create: ["test/t1.test.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": t1Spec },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    const crashInfo = await runUntilBoundaryAndCrash(
      {
        cwd: env.repoRoot,
        prompt: "Execute garbage bytes test",
        mode: "plan",
        permission_mode: "bypassPermissions",
        adapter: env.adapter,
      },
      4
    );

    expect(crashInfo.crashedSeq).toBe(4);

    // Corrupt the tail with garbage bytes
    corruptEventLogTail(crashInfo.runDir, "garbage_bytes");

    const store = new EventStoreImpl(runId, { baseDir: env.repoRoot });
    const recoveredEvents = await store.readAll();
    expect(recoveredEvents.length).toBe(4);

    const summary = await resumeAfterCrash(runId, {
      cwd: env.repoRoot,
      adapter: env.adapter,
    });

    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);

    const finalEvents = readEventLog(env.runDir, runId);
    for (let i = 0; i < finalEvents.length; i++) {
      expect(finalEvents[i].seq).toBe(i + 1);
    }
  });

  it("throws fatal corruption error when non-terminal line is corrupted", async () => {
    const runId: RunId = "r_TORNCCCCFAIL";
    const runDir = join(env.repoRoot, ".substrate", "runs", runId);
    const eventsPath = join(runDir, "events.jsonl");

    // Create 5 valid events
    const validLines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      validLines.push(
        JSON.stringify({
          v: 1,
          seq: i,
          ts: new Date().toISOString(),
          run_id: runId,
          type: "task.ready",
          data: { task_id: "T1" },
        })
      );
    }

    // Corrupt line 2 (non-terminal line)
    validLines[1] = "NOT_VALID_JSON_ON_LINE_2";

    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(eventsPath, validLines.join("\n") + "\n", "utf8");

    const store = new EventStoreImpl(runId, { baseDir: env.repoRoot });
    await expect(store.readAll()).rejects.toThrow(/Corruption error.*line 2/);
  });

  it("gracefully treats trailing empty newlines as clean EOF", async () => {
    const runId: RunId = "r_TORNDDDDEOF2";
    const runDir = join(env.repoRoot, ".substrate", "runs", runId);
    const eventsPath = join(runDir, "events.jsonl");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });

    const event = {
      v: 1,
      seq: 1,
      ts: new Date().toISOString(),
      run_id: runId,
      type: "run.created",
      data: { run_id: runId, prompt: "test", mode: "plan", permission_mode: "bypassPermissions" },
    };
    writeFileSync(eventsPath, JSON.stringify(event) + "\n\n", "utf8");

    const store = new EventStoreImpl(runId, { baseDir: env.repoRoot });
    const events = await store.readAll();
    expect(events.length).toBe(1);
    expect(events[0].seq).toBe(1);
  });
});
