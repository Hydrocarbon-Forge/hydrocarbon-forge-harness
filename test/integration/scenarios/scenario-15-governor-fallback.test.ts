import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import type {
  Manifest,
  RunId,
  RunSummary,
} from "../../../src/contracts/index.js";
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

describe("Scenario 15: Governor Down -> Deterministic Fallback (§14.5 #15)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("15-governor-fallback", {
      customSettings: {
        roles: {
          planner: { backend: "fake", model: "claude-haiku-5-5" },
          governor: {
            enabled: true,
            // Point to a dead / non-existent local port
            endpoint: "http://127.0.0.1:54321/v1",
            enable_thinking: false,
            timeout_s: 1,
          },
        },
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("gracefully catches governor failure, logs warning event, and falls back to rules router", async () => {
    const runId: RunId = "r_151515ABCDEF";

    const mockAdapter = createMockAdapter({
      nextSession() {
        return {
          result: {
            ok: true,
            exit_code: 0,
            final_text: "Worker passed",
          },
        };
      },
    });

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown();
    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    // Run in auto mode with governor enabled but offline
    const summary: RunSummary = await engine.run({
      prompt: "Implement simple calculation feature",
      cwd: env.repoRoot,
      mode: "auto",
      permission_mode: "bypassPermissions",
    });

    // Invariant: should NOT throw or crash; falls back and succeeds
    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);

    // Events log should record governor fallback
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("governor.fallback");
    expect(eventTypes).toContain("run.routed");
  });
});
