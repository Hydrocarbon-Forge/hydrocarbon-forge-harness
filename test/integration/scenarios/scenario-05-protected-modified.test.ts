import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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

describe("Scenario 05: Protected File Modified (§14.5 #5)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("05-protected-modified");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("fails task as protected_modified when worker tampers with protected file", async () => {
    const runId: RunId = "r_555555ABCDEF";

    // Commit a protected test file in base repo
    env.testRepo.commitFile(
      "test/protected.test.ts",
      "describe('protected test', () => { it('must pass', () => {}); });\n",
      "initial protected test"
    );

    const mockAdapter = createMockAdapter({
      nextSession() {
        return {
          result: {
            ok: true,
            exit_code: 0,
            final_text: "Worker tampered with protected test",
            files_changed: ["test/protected.test.ts", "src/feature.ts"],
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
        title: "Protected Task",
        depends_on: [],
        write: ["src/feature.ts"],
        create: [],
        protected: ["test/protected.test.ts", "contracts/types.ts"],
        verify: [{ run: "echo verify", timeout_s: 30 }],
      },
    });

    writePlanFiles(
      env.repoRoot,
      runId,
      manifest,
      { "tasks/T1.md": t1Spec },
      { "contracts/types.ts": "// original contract\n" }
    );

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute task with protected files",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: task must fail with protected_modified
    expect(summary.tasks.T1?.state).toBe("FAILED");
    expect(summary.tasks.T1?.failure_class).toBe("protected_modified");

    // Events log verification
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("task.failed");

    const failedEvt = events.find((e) => e.type === "task.failed");
    expect((failedEvt?.data as any)?.failure_class).toBe("protected_modified");
  });
});
