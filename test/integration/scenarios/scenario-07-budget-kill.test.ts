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

describe("Scenario 07: Budget Kill (Cost Overshoot) (§14.5 #7)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("07-budget-kill", {
      customSettings: {
        budgets: {
          ...env?.settings?.budgets,
          run: {
            max_usd: 1.0, // 1 USD budget cap
            max_tokens: 100000,
          },
          task: { max_usd: 1.0 },
          l1_replans_per_task: 2,
          l2_per_run: 2,
          planner_format_retries: 2,
          approval_threshold_usd: 5.0,
        },
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("kills process group and pauses run with exit code 4 when cost hits 100% of max_usd", async () => {
    const runId: RunId = "r_777777ABCDEF";
    let killReasonReceived: string | undefined;

    const mockAdapter = createMockAdapter({
      nextSession() {
        return {
          events: [
            { type: "session.started", session_id: "sess-budget-1" },
            {
              type: "usage",
              record: {
                backend: "fake",
                model: "claude-haiku-5-5",
                input_tokens: 50000,
                output_tokens: 25000,
                cost_usd: 0.85, // 85% -> triggers warning
                cost_source: "reported",
                at: new Date().toISOString(),
              },
              cumulative: true,
            },
            {
              type: "usage",
              record: {
                backend: "fake",
                model: "claude-haiku-5-5",
                input_tokens: 70000,
                output_tokens: 35000,
                cost_usd: 1.05, // > 100% -> triggers budget kill
                cost_source: "reported",
                at: new Date().toISOString(),
              },
              cumulative: true,
            },
          ],
          result: {
            ok: false,
            exit_code: null,
            final_text: "Budget exceeded",
            killed_for: "budget",
          },
          onKill(reason) {
            killReasonReceived = reason;
          },
        };
      },
    });

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Budget Expensive Task",
        depends_on: [],
        write: ["src/feature.ts"],
        verify: [{ run: "echo verify", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute budget test task",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: paused with budget_exhausted and exit code 4
    expect(summary.status).toBe("paused");
    expect(summary.pause_reason).toBe("budget_exhausted");
    expect(summary.exit_code).toBe(4);

    // Invariant: kill called with budget reason
    expect(killReasonReceived).toBe("budget");

    // Events log verification: budget warning at >=80%, budget exceeded at >=100%
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("run.budget.warning");
    expect(eventTypes).toContain("run.budget.exceeded");
    expect(eventTypes).toContain("run.paused");
  });
});
