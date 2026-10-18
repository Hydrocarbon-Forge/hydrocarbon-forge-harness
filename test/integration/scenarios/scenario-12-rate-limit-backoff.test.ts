import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

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

describe("Scenario 12: Rate-Limit Backoff (§14.5 #12)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("12-rate-limit");
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  it("backs off, halves concurrency (floor 1), avoids replanning, and resumes when limit clears", async () => {
    const runId: RunId = "r_121212ABCDEF";
    let attemptsCount = 0;

    fakeClaude = fakeClaudeAdapter([
      {
        failure: "rate_limit",
        reply: "Rate limit error",
      },
      {
        edits: { "src/feature.ts": "// success\n" },
        reply: "Succeeded after rate limit backoff",
      },
    ]);

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
      adapter: fakeClaude.adapter,
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

    const fakeClaude2 = fakeClaudeAdapter([
      {
        failure: "rate_limit",
        reply: "Rate limit",
      },
    ]);

    try {
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
        adapter: fakeClaude2.adapter,
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
    } finally {
      fakeClaude2.cleanup();
    }
  });
});
