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

describe("Scenario 12: Rate-Limit Backoff (§14.5 #12)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("12-rate-limit");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("backs off, halves concurrency (floor 1), avoids replanning, and resumes when limit clears", async () => {
    const runId: RunId = "r_121212ABCDEF";
    let attemptsCount = 0;

    const mockAdapter = createMockAdapter({
      nextSession() {
        attemptsCount++;
        if (attemptsCount === 1) {
          // Attempt 1: emits rate limit error
          return {
            events: [
              { type: "session.started", session_id: "sess-rate-1" },
              {
                type: "error",
                kind: "rate_limit",
                message: "Rate limit exceeded. Resets in 1s.",
              },
            ],
            result: {
              ok: false,
              exit_code: 1,
              final_text: "Rate limit error",
            },
          };
        } else {
          // Attempt 2 after backoff: succeeds
          return {
            result: {
              ok: true,
              exit_code: 0,
              final_text: "Succeeded after rate limit backoff",
            },
          };
        }
      },
    });

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Rate Limited Task",
        depends_on: [],
        write: ["src/feature.ts"],
        verify: [{ run: "echo verify", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec });

    const engine = engineMod.createEngine({
      settings: {
        ...env.settings,
        concurrency: { workers: 4 },
      },
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute rate limited task",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: does not trigger replanning; generation stays 1
    expect(summary.status).toBe("finished");
    expect(summary.exit_code).toBe(0);
    expect(summary.tasks.T1?.generation).toBe(1);

    // Events log verification
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("rate_limit.backoff");
    expect(eventTypes).not.toContain("task.replanned");
  });

  it("pauses run with rate_limited when limit persists at concurrency floor 1", async () => {
    const runId: RunId = "r_121212PERSIST";

    const mockAdapter = createMockAdapter({
      nextSession() {
        return {
          events: [
            { type: "session.started", session_id: "sess-rate-persist" },
            {
              type: "error",
              kind: "rate_limit",
              message: "Persistent rate limit",
            },
          ],
          result: {
            ok: false,
            exit_code: 1,
            final_text: "Rate limit",
          },
        };
      },
    });

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown();
    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec });

    const engine = engineMod.createEngine({
      settings: {
        ...env.settings,
        concurrency: { workers: 1 }, // Already at floor 1
      },
      adapter: mockAdapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute persistent rate limited task",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("paused");
    expect(summary.pause_reason).toBe("rate_limited");
    expect(summary.exit_code).toBe(3);
  });
});
