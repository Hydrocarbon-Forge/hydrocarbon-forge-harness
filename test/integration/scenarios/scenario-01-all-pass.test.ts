import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type {
  Manifest,
  RunId,
  EngineEvent,
  RunSummary,
} from "../../../src/contracts/index.js";
import type { EngineState } from "../../../src/engine/reducer.js";
import { reduce } from "../../../src/engine/reducer.js";
import {
  setupScenarioEnv,
  loadEngine,
  loadEffects,
  writePlanFiles,
  readEventLog,
  type ScenarioEnv,
  type EngineModule,
  type EffectsModule,
} from "./helpers.js";
import {
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../roles/fixtures.js";

describe("Scenario 01: All-pass batch (§14.5 #1)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("01-all-pass");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes independent tasks to clean merge and integration verification pass", async () => {
    const runId: RunId = "r_111111ABCDEF";
    const runBranch = `substrate/runs/${runId}`;

    // Manifest with two independent tasks T1, T2
    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
      integration_verify: [
        { run: "echo integration verify passed", timeout_s: 30 },
      ],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Task 1 Implementation",
        depends_on: [],
        write: ["src/t1.ts"],
        create: ["test/t1.test.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    const t2Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T2",
        title: "Task 2 Implementation",
        depends_on: [],
        write: ["src/t2.ts"],
        create: ["test/t2.test.ts"],
        verify: [{ run: "echo verify T2", timeout_s: 30 }],
      },
    });

    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": t1Spec, "tasks/T2.md": t2Spec },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: env.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Implement tasks T1 and T2",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: exit 0 on clean pass
    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
    expect(summary.tasks.T1?.state).toBe("PASSED");
    expect(summary.tasks.T2?.state).toBe("PASSED");
    expect(summary.tasks.T1?.generation).toBe(1);
    expect(summary.tasks.T2?.generation).toBe(1);

    // Event sourcing truth: check event log replay
    const events = readEventLog(env.runDir, runId);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type).toBe("run.created");

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("batch.started");
    expect(eventTypes).toContain("batch.merged");
    expect(eventTypes).toContain("run.finished");

    // State derivation purity: replaying events via reduce must reconstruct state
    let state: EngineState = {
      run_id: runId,
      state: "CREATED",
      tasks: {},
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };
    for (const evt of events) {
      state = reduce(state, evt);
    }
    expect(state.state).toBe("FINISHED");
    expect(state.tasks.T1?.state).toBe("MERGED");
    expect(state.tasks.T2?.state).toBe("MERGED");

    // Lock exclusivity: run lock must be released after completion
    const lockPath = join(env.repoRoot, ".substrate", "state", `${runId}.lock`);
    expect(existsSync(lockPath)).toBe(false);

    // Run branch verification
    const runBranchHead = env.testRepo.git(["rev-parse", runBranch]);
    expect(runBranchHead).toBeTruthy();
  });

  it("effects runner nextActions schedules workers then merge then integration", async () => {
    const runId: RunId = "r_111111ABCDEF";
    const initialState: EngineState = {
      run_id: runId,
      state: "EXECUTING",
      tasks: {
        T1: { id: "T1", state: "READY", generation: 1, attempt: 1 },
        T2: { id: "T2", state: "READY", generation: 1, attempt: 1 },
      },
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };

    const actions = effectsMod.nextActions(initialState, env.settings);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "worker", taskId: "T1" }),
        expect.objectContaining({ type: "worker", taskId: "T2" }),
      ])
    );

    // When both tasks pass, next action must be batch merge
    const passedState: EngineState = {
      ...initialState,
      tasks: {
        T1: { id: "T1", state: "PASSED", generation: 1, attempt: 1 },
        T2: { id: "T2", state: "PASSED", generation: 1, attempt: 1 },
      },
    };
    const mergeActions = effectsMod.nextActions(passedState, env.settings);
    expect(mergeActions).toEqual([
      expect.objectContaining({ type: "merge", batch: ["T1", "T2"] }),
    ]);
  });

  it("handles zero-task plan by exiting 0 with finished status (edge case)", async () => {
    const runId: RunId = "r_111111ZERO00";
    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [],
    };

    writePlanFiles(env.repoRoot, runId, manifest, {});

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: env.adapter,
    });

    const summary = await engine.run({
      prompt: "No tasks to execute",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
    expect(Object.keys(summary.tasks)).toHaveLength(0);
  });

  it("recovers from stale run lock when previous PID is inactive (edge case)", async () => {
    const runId: RunId = "r_111111STALE0";
    const lockPath = join(env.repoRoot, ".substrate", "state", `${runId}.lock`);

    // Write a stale lock with dead PID 999999
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, timestamp: Date.now() - 1000000 }),
      "utf8"
    );

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };
    writePlanFiles(env.repoRoot, runId, manifest, {
      "tasks/T1.md": sampleValidTaskSpecMarkdown(),
    });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: env.adapter,
    });

    const summary = await engine.run({
      prompt: "Stale lock recovery test",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
  });
});
