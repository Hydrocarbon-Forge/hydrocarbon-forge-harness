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

describe("Scenario 14: L2 Amendment Invalidates Dependents (§14.5 #14)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("14-l2-amendment", {
      customSettings: {
        budgets: {
          ...env?.settings?.budgets,
          l1_replans_per_task: 1, // Only 1 L1 replan allowed, then L2
          l2_per_run: 2,
        },
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("triggers L2 contract amendment, re-checks contracts, and invalidates downstream dependent tasks", async () => {
    const runId: RunId = "r_141414ABCDEF";

    let l2PlannerInvoked = false;

    const mockAdapter = createMockAdapter({
      nextSession(req, index) {
        if (req.prompt.includes("L2") || req.prompt.includes("amend")) {
          l2PlannerInvoked = true;
          return {
            result: {
              ok: true,
              exit_code: 0,
              final_text: "Planner amended contracts and manifest",
            },
          };
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

    // DAG: T1 is upstream, T2 depends on T1
    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      contracts: {
        files: ["contracts/types.ts"],
        typecheck: [{ run: "echo typecheck contracts passed", timeout_s: 30 }],
      },
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Upstream Task T1",
        depends_on: [],
        write: ["src/t1.ts"],
        read: ["contracts/types.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    const t2Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T2",
        title: "Downstream Task T2 (depends on T1)",
        depends_on: ["T1"],
        write: ["src/t2.ts"],
        read: ["contracts/types.ts"],
        verify: [{ run: "echo verify T2", timeout_s: 30 }],
      },
    });

    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": t1Spec, "tasks/T2.md": t2Spec },
      { "contracts/types.ts": "export interface Config { timeout: number; }\n" }
    );

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute plan requiring L2 contract amendment",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Events log verification
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("replan.l2");
    expect(eventTypes).toContain("contracts.committed");
    expect(eventTypes).toContain("tasks.invalidated");

    // Dependent task T2 should have been invalidated and reset
    expect(summary.tasks.T2).toBeDefined();
  });
});
