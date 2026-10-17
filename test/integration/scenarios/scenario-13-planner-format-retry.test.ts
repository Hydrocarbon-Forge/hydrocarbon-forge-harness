import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import type {
  RunId,
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
import {
  sampleValidManifestYaml,
  sampleValidTaskSpecMarkdown,
  createMockAdapter,
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

    const mockAdapter = createMockAdapter({
      onSpawn(req) {
        spawnedRequests.push(req);
      },
      nextSession(req, index) {
        if (req.role === "planner" || index === 0) {
          plannerAttempts++;
          if (plannerAttempts === 1) {
            // Attempt 1: malformed YAML output
            return {
              result: {
                ok: true,
                exit_code: 0,
                final_text: "INVALID YAML: { unclosed bracket: [",
              },
            };
          } else {
            // Attempt 2: valid manifest and task spec output
            return {
              result: {
                ok: true,
                exit_code: 0,
                final_text: `\`\`\`yaml:manifest.yaml\n${sampleValidManifestYaml()}\n\`\`\`\n\n\`\`\`markdown:tasks/T1.md\n${sampleValidTaskSpecMarkdown()}\n\`\`\``,
              },
            };
          }
        }
        return {
          result: {
            ok: true,
            exit_code: 0,
            final_text: "Worker passed",
          },
        };
      },
    });

    const engine = engineMod.createEngine({
      settings: {
        ...env.settings,
        budgets: {
          ...env.settings.budgets,
          planner_format_retries: 2,
        },
      },
      adapter: mockAdapter,
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
  });

  it("fails run with exit code 1 when planner exhausts format retries", async () => {
    let plannerAttempts = 0;

    const mockAdapter = createMockAdapter({
      nextSession() {
        plannerAttempts++;
        return {
          result: {
            ok: true,
            exit_code: 0,
            final_text: "Continually malformed YAML: :::invalid:::",
          },
        };
      },
    });

    const engine = engineMod.createEngine({
      settings: {
        ...env.settings,
        budgets: {
          ...env.settings.budgets,
          planner_format_retries: 2,
        },
      },
      adapter: mockAdapter,
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
  });
});
