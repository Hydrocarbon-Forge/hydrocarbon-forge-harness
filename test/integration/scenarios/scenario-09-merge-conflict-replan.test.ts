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

describe("Scenario 09: Merge Conflict -> L1 Replan (§14.5 #9)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("09-merge-conflict");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("detects conflict via git merge-tree preflight and triggers L1 replan", async () => {
    const runId: RunId = "r_999999ABCDEF";

    // Create shared file in base repository
    env.testRepo.commitFile(
      "src/shared.ts",
      "export const sharedValue = 100;\n",
      "initial shared file"
    );

    let t2ReplanOccurred = false;

    const mockAdapter = createMockAdapter({
      nextSession(req, index) {
        if (req.prompt.includes("replan") || req.prompt.includes("L1")) {
          t2ReplanOccurred = true;
          return {
            result: {
              ok: true,
              exit_code: 0,
              final_text: "Planner produced revised spec resolving conflict",
            },
          };
        }
        return {
          result: {
            ok: true,
            exit_code: 0,
            final_text: "Worker passed verification",
          },
        };
      },
    });

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
    };

    // Both tasks declare editing the same shared file
    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Edit Shared Value A",
        depends_on: [],
        write: ["src/shared.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    const t2Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T2",
        title: "Edit Shared Value B (conflicting)",
        depends_on: [],
        write: ["src/shared.ts"],
        verify: [{ run: "echo verify T2", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, {
      "tasks/T1.md": t1Spec,
      "tasks/T2.md": t2Spec,
    });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute conflicting tasks",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: T2 encounters merge conflict and escalates to L1 replan (generation 2)
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("merge.conflict");
    expect(eventTypes).toContain("task.replanned");
    expect(summary.tasks.T2?.generation).toBeGreaterThanOrEqual(2);
  });
});
