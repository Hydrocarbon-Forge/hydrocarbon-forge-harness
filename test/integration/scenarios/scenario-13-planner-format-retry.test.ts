import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import type {
  RunId,
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
import {
  sampleValidManifestYaml,
  sampleValidTaskSpecMarkdown,
} from "../roles/fixtures.js";

describe("Scenario 13: Planner Format Retry (§14.5 #13)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("13-planner-format");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("retries planner session on invalid format and succeeds when retry returns valid format", async () => {
    const spawnedRequests: SpawnRequest[] = [];
    let plannerAttempts = 0;

    const fakeClaude = fakeClaudeAdapter([
      {
        reply: "INVALID YAML: { unclosed bracket: [",
      },
      {
        reply: `\`\`\`yaml:manifest.yaml\n${sampleValidManifestYaml()}\n\`\`\`\n\n\`\`\`markdown:tasks/T1.md\n${sampleValidTaskSpecMarkdown()}\n\`\`\``,
      },
    ]);

    const origSpawn = fakeClaude.adapter.spawn.bind(fakeClaude.adapter);
    fakeClaude.adapter.spawn = (req: SpawnRequest) => {
      spawnedRequests.push(req);
      if (req.role === "planner") {
        plannerAttempts++;
      }
      return origSpawn(req);
    };

    try {
      const engine = engineMod.createEngine({
        settings: {
          ...env.settings,
          budgets: {
            ...env.settings.budgets,
            planner_format_retries: 2,
          },
        },
        adapter: fakeClaude.adapter,
      });

      const summary: RunSummary = await engine.run({
        prompt: "Plan and implement feature",
        cwd: env.repoRoot,
        mode: "plan",
        permission_mode: "plan", // plan mode completes after planning
      });

      // Plan-only complete exits 0
      expect(summary.status).toBe("finished");
      expect(summary.exit_code).toBe(0);

      // Planner retried once
      expect(plannerAttempts).toBe(2);

      // Prompt in second planner attempt must include format retry hint
      expect(spawnedRequests[1]?.prompt).toContain("format");
    } finally {
      fakeClaude.cleanup();
    }
  });

  it("fails run with exit code 1 when planner exhausts format retries", async () => {
    let plannerAttempts = 0;

    const fakeClaude = fakeClaudeAdapter([
      { reply: "Continually malformed YAML: :::invalid:::" },
      { reply: "Continually malformed YAML: :::invalid:::" },
      { reply: "Continually malformed YAML: :::invalid:::" },
      { reply: "Continually malformed YAML: :::invalid:::" },
    ]);

    const origSpawn = fakeClaude.adapter.spawn.bind(fakeClaude.adapter);
    fakeClaude.adapter.spawn = (req: SpawnRequest) => {
      if (req.role === "planner") {
        plannerAttempts++;
      }
      return origSpawn(req);
    };

    try {
      const engine = engineMod.createEngine({
        settings: {
          ...env.settings,
          budgets: {
            ...env.settings.budgets,
            planner_format_retries: 2,
          },
        },
        adapter: fakeClaude.adapter,
      });

      const summary: RunSummary = await engine.run({
        prompt: "Plan with broken output",
        cwd: env.repoRoot,
        mode: "plan",
        permission_mode: "plan",
      });

      // Fails run when retries exhausted
      expect(summary.status).toBe("failed");
      expect(summary.exit_code).toBe(1);
      expect(plannerAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      fakeClaude.cleanup();
    }
  });
});
