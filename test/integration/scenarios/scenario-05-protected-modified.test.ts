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
} from "../roles/fixtures.js";

describe("Scenario 05: Protected File Modified (§14.5 #5)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("05-protected-modified");
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  it("fails task as protected_modified when worker tampers with protected file", async () => {
    const runId: RunId = "r_555555ABCDEF";

    // Commit a protected test file in base repo
    env.testRepo.commitFile(
      "test/protected.test.ts",
      "describe('protected test', () => { it('must pass', () => {}); });\n",
      "initial protected test"
    );

    fakeClaude = fakeClaudeAdapter([
      {
        edits: {
          "src/feature.ts": "// feature edit\n",
          "test/protected.test.ts": "// tampered\n",
        },
        reply: "Worker tampered with protected test",
      },
    ]);

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
      adapter: fakeClaude.adapter,
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
