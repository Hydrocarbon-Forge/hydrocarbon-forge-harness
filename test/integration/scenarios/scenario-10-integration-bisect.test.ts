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
  sampleValidContractStub,
} from "../roles/fixtures.js";

describe("Scenario 10: Integration Failure -> Bisect Culprit (§14.5 #10)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let effectsMod: EffectsModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;

  beforeAll(async () => {
    engineMod = await loadEngine();
    effectsMod = await loadEffects();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("10-integration-bisect");
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  it("bisects batch task-by-task to isolate culprit task, triggers L1 replan for culprit while keeping sibling merges", async () => {
    const runId: RunId = "r_JJJJJJABCDEF";

    fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      {
        task: "T1",
        edits: { "src/t1.ts": "// t1\n" },
        reply: "Worker passed verify",
      },
      {
        task: "T2",
        edits: { "src/t2.ts": "// t2\n" },
        reply: "Worker passed verify",
      },
      {
        reply: "Planner replanned culprit task T2\nREVISED T2",
      },
      {
        task: "T2",
        edits: { "src/t2.ts": "// t2 fixed\n" },
        reply: "Worker passed verify",
      },
    ]);

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
      // Integration verify will fail when both T1 and T2 are merged, but pass when T1 only is merged
      integration_verify: [
        {
          run: "node -e 'const fs=require(\"fs\"); if (fs.existsSync(\"src/t2.ts\")) process.exit(1); else process.exit(0);'",
          timeout_s: 30,
        },
      ],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Clean Task",
        depends_on: [],
        write: [],
        create: ["src/t1.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    const t2Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T2",
        title: "Culprit Task (breaks integration)",
        depends_on: [],
        write: [],
        create: ["src/t2.ts"],
        verify: [{ run: "echo verify T2", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, {
      "tasks/T1.md": t1Spec,
      "tasks/T2.md": t2Spec,
    }, { "contracts/types.ts": sampleValidContractStub() });

    // R12.4: repairs run before the culprit search. This test is about the bisect, so repairs are off here;
    // the repair path has its own e2e test (test/e2e/integration-repair.test.ts).
    const engine = engineMod.createEngine({
      settings: { ...env.settings, integration: { repair_attempts: 0 } },
      adapter: fakeClaude.adapter,
    });

    const summary: RunSummary = await engine.run({
      prompt: "Execute batch with semantic integration defect",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    // Invariant: T1 is merged, T2 is isolated as culprit and replanned
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("bisect.started");
    expect(eventTypes).toContain("bisect.culprit");

    const culpritEvt = events.find((e) => e.type === "bisect.culprit");
    expect((culpritEvt?.data as any)?.culprit_task_id).toBe("T2");

    // Sibling T1 remains merged
    expect(summary.tasks.T1?.state).toBe("PASSED");
    // Culprit T2 was replanned
    expect(summary.tasks.T2?.generation).toBeGreaterThanOrEqual(2);
  });

  it("a single-task plan whose integration verify would fail on its base is not verified again (R12.2): the run finishes, with no base check", async () => {
    const runId: RunId = "r_JJJJJJBASE22";

    fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      {
        edits: { "src/t1.ts": "// t1\n" },
        reply: "Worker passed verify",
      },
    ]);

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      // Fails on the base commit (src/t1.ts is created by T1), passes once T1 is merged
      integration_verify: [
        {
          run: "node -e 'process.exit(require(\"fs\").existsSync(\"src/t1.ts\") ? 0 : 1)'",
          timeout_s: 30,
        },
      ],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Task T1",
        depends_on: [],
        write: [],
        create: ["src/t1.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    writePlanFiles(env.repoRoot, runId, manifest, { "tasks/T1.md": t1Spec }, { "contracts/types.ts": sampleValidContractStub() });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });

    const summary = await engine.run({
      prompt: "Execute with a base integration verify that fails",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    expect(summary.status).toBe("finished");
    const events = readEventLog(env.runDir, runId);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).not.toContain("bisect.started");
    expect(eventTypes).not.toContain("bisect.culprit");
    expect(eventTypes).not.toContain("integration.failed");
    // R12.2: one task is not verified again, so no final verify starts and no base check runs.
    expect(events.filter((e) => e.type === "integration.skipped").map((e) => e.data)).toEqual([{ reason: "single_task" }]);
    expect(eventTypes).not.toContain("integration.started");
    expect(eventTypes).not.toContain("integration.finished");
  });
});
