import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import type {
  Manifest,
  RunId,
  RunSummary,
  SpawnRequest,
} from "../../../src/contracts/index.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
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

// Auto mode runs the deterministic router (src/roles/router.ts) on the default path. A
// named existing file with a mechanical verb routes to solo; anything else routes to plan.
// An explicit mode bypasses the router.
describe("Scenario 17: auto mode runs the deterministic router (routeRequest)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("17-auto-router", {
      customSettings: {
        roles: {
          planner: { backend: "claude", model: "claude-haiku-5-5" },
        },
      },
    });
    env.testRepo.commitFile("src/solo.ts", "export const solo = false;\n");
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  function trackSpawns(adapter: { spawn: (req: SpawnRequest) => any }): string[] {
    const roles: string[] = [];
    const origSpawn = adapter.spawn.bind(adapter);
    adapter.spawn = (req: SpawnRequest) => {
      roles.push(req.role ?? "worker");
      return origSpawn(req);
    };
    return roles;
  }

  it("auto mode routes a named-file mechanical request to solo and runs the solo worker", async () => {
    fakeClaude = fakeClaudeAdapter([
      {
        edits: { "src/solo.ts": "export const solo = true;\n" },
        reply: "Solo worker completed task",
      },
    ]);
    const spawnedRoles = trackSpawns(fakeClaude.adapter);

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Fix typo in src/solo.ts directly",
      cwd: env.repoRoot,
      mode: "auto",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
    expect(spawnedRoles).not.toContain("planner");
    expect(spawnedRoles).toContain("worker");

    const events = readEventLog(env.runDir, summary.run_id);
    const routed = events.find((e) => e.type === "run.routed");
    expect(routed?.data).toMatchObject({ mode: "solo" });
    expect(summary.tasks["SOLO"]?.state).toBe("PASSED");
  });

  it("auto mode routes a non-mechanical request to plan", async () => {
    const runId: RunId = "r_B5B5B5ABCDEF";
    fakeClaude = fakeClaudeAdapter([
      {
        reply: "wrote manifest.yaml and the task specs\nPLAN READY",
      },
      {
        reply: "Worker passed",
      },
    ]);
    const spawnedRoles = trackSpawns(fakeClaude.adapter);

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };
    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": sampleValidTaskSpecMarkdown() },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Implement simple calculation feature in src/solo.ts",
      cwd: env.repoRoot,
      mode: "auto",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(spawnedRoles).toContain("planner");

    const events = readEventLog(env.runDir, runId);
    const routed = events.find((e) => e.type === "run.routed");
    expect(routed?.data).toMatchObject({ mode: "plan" });
  });

  it("an explicit plan mode keeps a mechanical named-file request on the plan route", async () => {
    const runId: RunId = "r_B5B5B5ABCDEF";
    fakeClaude = fakeClaudeAdapter([
      {
        reply: "wrote manifest.yaml and the task specs\nPLAN READY",
      },
      {
        reply: "Worker passed",
      },
    ]);
    const spawnedRoles = trackSpawns(fakeClaude.adapter);

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };
    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": sampleValidTaskSpecMarkdown() },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Fix typo in src/solo.ts directly",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    expect(spawnedRoles).toContain("planner");

    const events = readEventLog(env.runDir, runId);
    const routed = events.find((e) => e.type === "run.routed");
    expect(routed?.data).toMatchObject({ mode: "plan" });
  });
});
