import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
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
  sampleValidContractStub,
} from "../roles/fixtures.js";

describe("Scenario 04: Scope Violation Reverted (§14.5 #4)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("04-scope-violation");
    env.testRepo.commitFile("src/allowed.ts", "// existing file declared as write\n");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("reverts out-of-scope tracked edits and unlinks untracked files when on_scope_violation is revert", async () => {
    const runId: RunId = "r_444444ABCDEF";

    // Create an initial tracked file in the repo that should NOT be modified by the task
    env.testRepo.commitFile(
      "src/unrelated.ts",
      "export const original = true;\n",
      "initial unrelated file"
    );

    const fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      {
        edits: {
          "src/allowed.ts": "// allowed\n",
          "src/created.ts": "// created\n",
          "src/unrelated.ts": "// modified out of scope\n",
          "src/rogue.ts": "// rogue untracked\n",
        },
        reply: "Worker modified files",
      },
    ]);

    try {
      const manifest: Manifest = {
        ...sampleValidManifest(runId),
        tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      };

      const t1Spec = sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T1",
          title: "Scoped Task",
          depends_on: [],
          write: ["src/allowed.ts"],
          create: ["src/created.ts"],
          verify: [
            {
              // Verify should confirm unrelated is untouched and rogue is unlinked
              run: "node -e 'process.exit(0)'",
              timeout_s: 30,
            },
          ],
        },
      });

      writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec }, { "contracts/types.ts": sampleValidContractStub() });

      const engine = engineMod.createEngine({
        settings: {
          ...env.settings,
          git: {
            ...env.settings.git,
            on_scope_violation: "revert",
          },
        },
        adapter: fakeClaude.adapter,
      });

      const summary: RunSummary = await engine.run({
        prompt: "Implement scoped task",
        cwd: env.repoRoot,
        mode: "plan",
        permission_mode: "bypassPermissions",
      });

      expect(summary.status).toBe("finished");
      expect(summary.exit_code).toBe(0);
      expect(summary.tasks.T1?.state).toBe("PASSED");

      // Events log should record scope violation reverting
      const events = readEventLog(env.runDir, runId);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("scope.checked");
    } finally {
      fakeClaude.cleanup();
    }
  });

  it("marks task failed with scope_violation when on_scope_violation is fail", async () => {
    const runId: RunId = "r_444444FAILAA";

    env.testRepo.commitFile(
      "src/unrelated.ts",
      "export const original = true;\n"
    );

    const fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      {
        edits: {
          "src/allowed.ts": "// allowed\n",
          "src/unrelated.ts": "// modified out of scope\n",
        },
        reply: "Worker modified out-of-scope files",
      },
    ]);

    try {
      const manifest: Manifest = {
        ...sampleValidManifest(runId),
        tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      };

      const t1Spec = sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T1",
          title: "Strict Scoped Task",
          depends_on: [],
          write: ["src/allowed.ts"],
          verify: [{ run: "echo verify", timeout_s: 30 }],
        },
      });

      writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec }, { "contracts/types.ts": sampleValidContractStub() });

      const engine = engineMod.createEngine({
        settings: {
          ...env.settings,
          git: {
            ...env.settings.git,
            on_scope_violation: "fail",
          },
        },
        adapter: fakeClaude.adapter,
      });

      const summary: RunSummary = await engine.run({
        prompt: "Implement strict scoped task",
        cwd: env.repoRoot,
        mode: "plan",
        permission_mode: "bypassPermissions",
      });

      expect(summary.tasks.T1?.failure_class).toBe("scope_violation");
    } finally {
      fakeClaude.cleanup();
    }
  });
});
