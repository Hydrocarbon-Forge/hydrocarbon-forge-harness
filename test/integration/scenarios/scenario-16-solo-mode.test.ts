import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  RunSummary,
  SpawnRequest,
} from "../../../src/contracts/index.js";
import {
  setupScenarioEnv,
  loadEngine,
  loadEffects,
  readEventLog,
  type ScenarioEnv,
  type EngineModule,
  type EffectsModule,
} from "./helpers.js";
import { createMockAdapter } from "../roles/fixtures.js";

describe("Scenario 16: Solo Mode (§14.5 #16)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("16-solo-mode");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("bypasses governor and planner, runs single worker session, verifies, and commits", async () => {
    const spawnedRoles: string[] = [];

    const mockAdapter = createMockAdapter({
      onSpawn(req: SpawnRequest) {
        spawnedRoles.push(req.role ?? "worker");
      },
      nextSession() {
        return {
          result: {
            ok: true,
            exit_code: 0,
            final_text: "Solo worker completed task",
            files_changed: ["src/solo.ts"],
          },
        };
      },
    });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Fix typo in src/solo.ts directly",
      cwd: env.repoRoot,
      mode: "solo",
      permission_mode: "bypassPermissions",
    });

    // Invariant: status finished, exit 0
    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);

    // Invariant: bypasses planner role completely
    expect(spawnedRoles).not.toContain("planner");
    expect(spawnedRoles).toContain("worker");

    // Manifest should NOT be created in run directory in solo mode
    const manifestPath = join(
      env.runDir,
      summary.run_id,
      "manifest.yaml"
    );
    expect(existsSync(manifestPath)).toBe(false);

    // Events log should record solo routing
    const events = readEventLog(env.runDir, summary.run_id);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("run.created");
    expect(eventTypes).toContain("run.routed");
    expect(eventTypes).toContain("task.passed");
    expect(eventTypes).toContain("run.finished");

    const routedEvt = events.find((e) => e.type === "run.routed");
    expect((routedEvt?.data as any)?.mode).toBe("solo");
  });
});
