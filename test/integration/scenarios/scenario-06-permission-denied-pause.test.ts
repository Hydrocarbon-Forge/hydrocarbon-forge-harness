import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { existsSync } from "node:fs";
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

describe("Scenario 06: Permission Denial -> Pause (Exit 3) (§14.5 #6)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      {
        failure: "permission_denial",
        reply: "Denied by policy",
      },
    ]);
    env = await setupScenarioEnv("06-permission-denied", { adapter: fakeClaude.adapter });
    env.testRepo.commitFile("src/feature.ts", "// existing file declared as write\n");
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  it("kills session, emits run.paused(permission_denied), does not replan, and exits with code 3", async () => {
    const runId: RunId = "r_666666ABCDEF";

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Permission Sensitive Task",
        depends_on: [],
        write: ["src/feature.ts"],
        verify: [{ run: "echo verify", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec }, { "contracts/types.ts": sampleValidContractStub() });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude!.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute task triggering tool denial",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "dontAsk",
    });

    // Invariant: pause with exit code 3 and pause_reason permission_denied
    expect(summary.status).toBe("paused");
    expect(summary.pause_reason).toBe("permission_denied");
    expect(summary.exit_code).toBe(3);

    // Invariant: zero replan on denials
    expect(summary.tasks.T1?.generation).toBe(1);

    // Lock exclusivity: run lock must be released when paused
    const lockPath = join(env.repoRoot, ".substrate", "state", `${runId}.lock`);
    expect(existsSync(lockPath)).toBe(false);

    // Events log verification
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("run.paused");
    expect(eventTypes).not.toContain("task.replanned");
  });
});
