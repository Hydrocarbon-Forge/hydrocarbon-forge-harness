import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  RunSummary,
  SpawnRequest,
} from "../../../src/contracts/index.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
  loadEngine,
  loadEffects,
  readEventLog,
  type ScenarioEnv,
  type EngineModule,
  type EffectsModule,
} from "./helpers.js";

describe("Scenario 16: Solo Mode (§14.5 #16)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("16-solo-mode");
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  it("bypasses governor and planner, runs single worker session, verifies, and commits", async () => {
    const spawnedRoles: string[] = [];

    fakeClaude = fakeClaudeAdapter([
      {
        edits: { "src/solo.ts": "export const solo = true;\n" },
        reply: "Solo worker completed task",
      },
    ]);

    const origSpawn = fakeClaude.adapter.spawn.bind(fakeClaude.adapter);
    fakeClaude.adapter.spawn = (req: SpawnRequest) => {
      spawnedRoles.push(req.role ?? "worker");
      return origSpawn(req);
    };

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
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

    const passedEvt = events.find((e) => e.type === "task.passed");
    expect((passedEvt?.data as any)?.task_id).toBe("SOLO");

    expect(summary.tasks["SOLO"]).toBeDefined();
    expect(summary.tasks["SOLO"].state).toBe("PASSED");
  });

  it("roles.worker.effort reaches the solo worker spawn request", async () => {
    const spawnRequests: SpawnRequest[] = [];

    fakeClaude = fakeClaudeAdapter([
      {
        edits: { "src/solo.ts": "export const solo = true;\n" },
        reply: "Solo worker completed task",
      },
    ]);

    const origSpawn = fakeClaude.adapter.spawn.bind(fakeClaude.adapter);
    fakeClaude.adapter.spawn = (req: SpawnRequest) => {
      if (req.role === "worker") spawnRequests.push(req);
      return origSpawn(req);
    };

    env.settings = {
      ...env.settings,
      roles: {
        ...env.settings.roles,
        worker: { backend: "claude", model: "claude-sonnet-5-5", effort: "high" },
      },
    };

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Fix typo in src/solo.ts directly",
      cwd: env.repoRoot,
      mode: "solo",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(spawnRequests.length).toBeGreaterThan(0);
    expect(spawnRequests[0].effort).toBe("high");
  });
});
