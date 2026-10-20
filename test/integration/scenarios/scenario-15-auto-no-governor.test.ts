import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import type {
  Manifest,
  RunId,
  RunSummary,
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

describe("Scenario 15: auto mode with no governor routes to the plan route (§14.5 #15)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("15-auto-no-governor", {
      customSettings: {
        roles: {
          // The run uses the fake claude harness, so the planner route must name the
          // backend the adapter reports.
          planner: { backend: "claude", model: "claude-haiku-5-5" },
        },
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  it("runs in auto mode with no governor: routes to plan, finishes, and records no governor event", async () => {
    const runId: RunId = "r_B5B5B5ABCDEF";

    fakeClaude = fakeClaudeAdapter([
      {
        reply: "wrote manifest.yaml and the task specs\nPLAN READY",
      },
      {
        reply: "Worker passed",
      },
    ]);

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown();
    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": t1Spec },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });

    // Auto mode with no governor configured takes the plan route.
    const summary: RunSummary = await engine.run({
      prompt: "Implement simple calculation feature",
      cwd: env.repoRoot,
      mode: "auto",
      permission_mode: "bypassPermissions",
    });

    // Invariant: should NOT throw or crash; falls back and succeeds
    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);

    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("run.routed");
    expect(eventTypes.some((t) => t.startsWith("governor"))).toBe(false);
    const routed = events.find((e) => e.type === "run.routed");
    expect(routed?.data).toMatchObject({ mode: "plan" });
  });
});
