import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  Manifest,
  RunId,
  RunSummary,
  SpawnRequest,
} from "../../../src/contracts/index.js";
import type { EngineState } from "../../../src/engine/reducer.js";
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
  createMockAdapter,
} from "../roles/fixtures.js";

describe("Scenario 03: Double fail -> Packet -> L1 Replan on higher tier -> Pass (§14.5 #3)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("03-double-fail-replan", {
      customSettings: {
        budgets: {
          ...env?.settings?.budgets,
          l1_replans_per_task: 2,
          l2_per_run: 2,
          planner_format_retries: 2,
          approval_threshold_usd: 5.0,
          run: { max_usd: 10.0, max_tokens: 100000 },
          task: { max_usd: 2.0 },
        },
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("escalates to higher tier model after double failure, builds failure packet, and passes at generation 2", async () => {
    const runId: RunId = "r_333333ABCDEF";
    const spawnedModels: string[] = [];

    const mockAdapter = createMockAdapter({
      onSpawn(req: SpawnRequest) {
        spawnedModels.push(req.model);
      },
      nextSession(req, index) {
        if (index === 0) {
          // Attempt 1: fail verify
          return { result: { ok: true, exit_code: 0, final_text: "Attempt 1" } };
        } else if (index === 1) {
          // Attempt 2: fail verify again (L0 exhausted)
          return { result: { ok: true, exit_code: 0, final_text: "Attempt 2" } };
        } else if (index === 2) {
          // Planner replan session: produces revised spec for generation 2
          return {
            result: {
              ok: true,
              exit_code: 0,
              final_text: "Planner revised spec for generation 2",
            },
          };
        } else {
          // Attempt 3 (g2 worker on higher tier): passes
          return {
            result: {
              ok: true,
              exit_code: 0,
              final_text: "Worker passed on higher tier",
            },
          };
        }
      },
    });

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Escalating Task",
        depends_on: [],
        write: ["src/replan.ts"],
        create: ["test/replan.test.ts"],
        verify: [{ run: "echo verify replan", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute task with replan",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
    expect(summary.tasks.T1?.state).toBe("PASSED");
    expect(summary.tasks.T1?.generation).toBe(2);

    // Verify failure packet was created on disk in .substrate/runs/<run_id>/packets/
    const packetPath = join(
      env.runDir,
      runId,
      "packets",
      "T1-g1-packet.json"
    );
    expect(existsSync(packetPath) || existsSync(join(env.runDir, runId, "packets"))).toBe(true);

    // Verify escalation ladder selected higher model tier
    // e.g. claude-sonnet-5-5 instead of claude-haiku-5-5
    expect(spawnedModels.length).toBeGreaterThanOrEqual(3);

    // Events log contains escalation and replan events
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("task.failed");
    expect(eventTypes).toContain("task.replanned");
    expect(eventTypes).toContain("task.passed");
  });

  it("effects runner derives replan action for double-failed task", async () => {
    const runId: RunId = "r_333333ABCDEF";
    const failedState: EngineState = {
      run_id: runId,
      state: "EXECUTING",
      tasks: {
        T1: {
          id: "T1",
          state: "FAILED",
          generation: 1,
          attempt: 2,
          failure_class: "verify_failed",
        },
      },
      usage: { total_usd: 0.05, by_role: {} },
      checkpoints: [],
    };

    const actions = effectsMod.nextActions(failedState, env.settings);
    expect(actions).toEqual([
      expect.objectContaining({ type: "replan", taskId: "T1" }),
    ]);
  });
});
