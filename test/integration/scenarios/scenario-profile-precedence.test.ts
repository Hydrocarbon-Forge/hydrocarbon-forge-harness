import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import type {
  Profile,
  RunSummary,
  Settings,
  SpawnRequest,
} from "../../../src/contracts/index.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
  loadEngine,
  loadEffects,
  type ScenarioEnv,
  type EngineModule,
  type EffectsModule,
} from "./helpers.js";

// R6.5 (known issues item 11): built-in fallback < selected profile slots < explicit user
// settings. Solo mode is the path that reads the feature route and roles.worker, so these
// tests check the model on the solo worker's spawn request through the fake claude harness.
const WORK_PROFILE: Profile = {
  plan: { model: "profile-plan" },
  work: { model: "profile-work", effort: "low" },
  fast: { model: "profile-fast" },
};

describe("Scenario: profiles reach the solo worker spawn (R6.5)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("profile-precedence", {});
    env.testRepo.commitFile("src/solo.ts", "export const solo = false;\n");
    fakeClaude = fakeClaudeAdapter([
      {
        edits: { "src/solo.ts": "export const solo = true;\n" },
        reply: "Solo worker completed task",
      },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  async function runSolo(settings: Settings): Promise<{ summary: RunSummary; spawns: SpawnRequest[] }> {
    const spawns: SpawnRequest[] = [];
    const origSpawn = fakeClaude!.adapter.spawn.bind(fakeClaude!.adapter);
    fakeClaude!.adapter.spawn = (req: SpawnRequest) => {
      if (req.role === "worker") spawns.push(req);
      return origSpawn(req);
    };

    const engine = engineMod.createEngine({
      settings,
      adapter: fakeClaude!.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Fix typo in src/solo.ts directly",
      cwd: env.repoRoot,
      mode: "solo",
      permission_mode: "bypassPermissions",
    });
    return { summary, spawns };
  }

  it("with no profile and no user routing, the solo worker is the built-in claude route", async () => {
    const { summary, spawns } = await runSolo(env.settings);

    expect(summary.status).toBe("finished");
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns[0].model).toBe("claude-sonnet-5-5");
    expect(spawns[0].effort).toBe("medium");
  });

  it("a worker profile alone sets the solo worker's model and effort", async () => {
    const settings: Settings = {
      ...env.settings,
      profiles: { claude: WORK_PROFILE },
      defaults: { worker_provider: "claude" },
    };

    const { summary, spawns } = await runSolo(settings);

    expect(summary.status).toBe("finished");
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns[0].model).toBe("profile-work");
    expect(spawns[0].effort).toBe("low");
  });

  it("an explicit routing.feature beats the profile for the solo worker", async () => {
    const settings: Settings = {
      ...env.settings,
      profiles: { claude: WORK_PROFILE },
      defaults: { worker_provider: "claude" },
      routing: {
        ...env.settings.routing,
        feature: { backend: "claude", model: "explicit-feature", effort: "high" },
      },
    };

    const { summary, spawns } = await runSolo(settings);

    expect(summary.status).toBe("finished");
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns[0].model).toBe("explicit-feature");
    expect(spawns[0].effort).toBe("high");
  });

  it("an explicit roles.worker model beats the profile for the solo worker", async () => {
    const settings: Settings = {
      ...env.settings,
      profiles: { claude: WORK_PROFILE },
      defaults: { worker_provider: "claude" },
      roles: {
        ...env.settings.roles,
        worker: { model: "explicit-worker" },
      },
    };

    const { summary, spawns } = await runSolo(settings);

    expect(summary.status).toBe("finished");
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns[0].model).toBe("explicit-worker");
    expect(spawns[0].effort).toBe("low");
  });
});
