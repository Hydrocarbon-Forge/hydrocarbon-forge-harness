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

describe("Scenario 08: Timeout Kills Process Group (§14.5 #8)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("08-timeout-kill");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("kills process group and marks task timeout when execution exceeds timeout limit", async () => {
    const runId: RunId = "r_888888ABCDEF";
    let killReasonReceived: string | undefined;

    const mockAdapter = createMockAdapter({
      nextSession() {
        return {
          events: [
            { type: "session.started", session_id: "sess-timeout-1" },
            { type: "assistant.text", text: "Hanging indefinitely..." },
          ],
          result: {
            ok: false,
            exit_code: null,
            final_text: "Session timed out",
            killed_for: "timeout",
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

    // Task spec with short timeout (e.g. 1 second)
    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Timeout Task",
        depends_on: [],
        write: ["src/feature.ts"],
        verify: [{ run: "sleep 10", timeout_s: 1 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec });

    const engine = engineMod.createEngine({
      settings: {
        ...env.settings,
        budgets: {
          ...env.settings.budgets,
          task: { timeout_min: 0.05 }, // ~3 seconds
        },
      },
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute timing out task",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: task marked failed with timeout
    expect(summary.tasks.T1?.failure_class).toBe("timeout");

    // Invariant: kill called with timeout
    expect(killReasonReceived).toBe("timeout");

    // Events log contains timeout failure
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("task.failed");
  });
});
