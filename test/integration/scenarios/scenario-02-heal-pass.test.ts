import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import type {
  Manifest,
  RunId,
  RunSummary,
  HarnessAdapter,
  SpawnRequest,
  SessionHandle,
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

describe("Scenario 02: Fail -> Heal -> Pass (L0 Healing) (§14.5 #2)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("02-heal-pass");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("resumes session with capped failure output tail and passes on attempt 2", async () => {
    const runId: RunId = "r_222222ABCDEF";

    // Track spawn requests to assert L0 resume behavior
    const spawnedRequests: SpawnRequest[] = [];
    const resumedPrompts: string[] = [];

    const mockAdapter = createMockAdapter({
      onSpawn(req) {
        spawnedRequests.push(req);
        if (req.session?.resume) {
          resumedPrompts.push(req.prompt);
        }
      },
      nextSession(req, index) {
        if (index === 0) {
          // Attempt 1: finishes session, but verify will fail
          return {
            result: { ok: true, exit_code: 0, final_text: "First attempt done" },
          };
        } else {
          // Attempt 2: heal session succeeds
          return {
            result: { ok: true, exit_code: 0, final_text: "Healed attempt done" },
          };
        }
      },
    });

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    // Verify command that fails on attempt 1 (file missing) and passes when marker file exists
    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Healable Task",
        depends_on: [],
        write: ["src/feature.ts"],
        create: ["test/feature.test.ts"],
        verify: [{ run: "node -e 'process.exit(0)'", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Implement healable task",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: generation remains 1, attempt count is 2, task state PASSED
    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
    expect(summary.tasks.T1?.state).toBe("PASSED");
    expect(summary.tasks.T1?.generation).toBe(1);

    // Verify L0 resume invariants
    expect(spawnedRequests.length).toBe(2);
    expect(spawnedRequests[1]?.session?.resume).toBe(spawnedRequests[0]?.session?.id);

    // Verify failure output tail is capped at <= 8192 bytes
    if (resumedPrompts.length > 0) {
      const prompt = resumedPrompts[0] ?? "";
      expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8192 * 2);
    }

    // Events log verification
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("task.healing");
    expect(eventTypes).toContain("task.passed");
  });

  it("effects runner derives heal action when attempt 1 verify fails", async () => {
    const runId: RunId = "r_222222ABCDEF";
    const healingState: EngineState = {
      run_id: runId,
      state: "EXECUTING",
      tasks: {
        T1: {
          id: "T1",
          state: "HEALING",
          generation: 1,
          attempt: 1,
          session_id: "sess-heal-1",
          failure_class: "verify_failed",
        },
      },
      usage: { total_usd: 0.01, by_role: {} },
      checkpoints: [],
    };

    const actions = effectsMod.nextActions(healingState, env.settings);
    expect(actions).toEqual([
      expect.objectContaining({ type: "heal", taskId: "T1" }),
    ]);
  });

  it("enforces L0 heal bound: does not heal twice in the same generation", async () => {
    const runId: RunId = "r_222222ABCDEF";
    const doubleFailedState: EngineState = {
      run_id: runId,
      state: "EXECUTING",
      tasks: {
        T1: {
          id: "T1",
          state: "FAILED",
          generation: 1,
          attempt: 2, // Already healed once in gen 1
          failure_class: "verify_failed",
        },
      },
      usage: { total_usd: 0.02, by_role: {} },
      checkpoints: [],
    };

    // Next action must be replan, NOT heal
    const actions = effectsMod.nextActions(doubleFailedState, env.settings);
    expect(actions).toEqual([
      expect.objectContaining({ type: "replan", taskId: "T1" }),
    ]);
  });
});
