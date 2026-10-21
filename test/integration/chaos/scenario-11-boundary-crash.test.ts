import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  Manifest,
  RunId,
  EngineEvent,
  RunSummary,
} from "../../../src/contracts/index.js";
import { reduce, type EngineState } from "../../../src/engine/reducer.js";
import { createRunId } from "../../../src/util/index.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
  writePlanFiles,
  readEventLog,
  type ScenarioEnv,
} from "../scenarios/helpers.js";
import {
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../roles/fixtures.js";
import {
  runUntilBoundaryAndCrash,
  resumeAfterCrash,
} from "./helpers.js";

describe("Scenario 11: Kill and resume at every event boundary (§14.5 #11)", () => {
  let env: ScenarioEnv;

  beforeEach(async () => {
    env = await setupScenarioEnv("chaos-boundary");
    // L007 needs write patterns to match files that exist at the base commit.
    env.testRepo.commitFile("src/t1.ts", "// existing file declared as write\n");
    env.testRepo.commitFile("src/t2.ts", "// existing file declared as write\n");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("discovers total event count in a clean multi-task run, then kills and resumes at each boundary", async () => {
    const baselineRunId: RunId = createRunId();

    const manifest: Manifest = {
      ...sampleValidManifest(baselineRunId),
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
      integration_verify: [
        { run: "echo integration verify pass", timeout_s: 30 },
      ],
    };

    const t1Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Task 1",
        depends_on: [],
        write: ["src/t1.ts"],
        create: ["test/t1.test.ts"],
        verify: [{ run: "echo verify T1", timeout_s: 30 }],
      },
    });

    const t2Spec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T2",
        title: "Task 2",
        depends_on: [],
        write: ["src/t2.ts"],
        create: ["test/t2.test.ts"],
        verify: [{ run: "echo verify T2", timeout_s: 30 }],
      },
    });

    writePlanFiles(
      env.repoRoot,
      baselineRunId,
      manifest,
      { "tasks/T1.md": t1Spec, "tasks/T2.md": t2Spec },
      { "contracts/types.ts": sampleValidContractStub() }
    );

    const baselineClaude = fakeClaudeAdapter([
      {
        reply: "wrote manifest.yaml and the task specs\nPLAN READY",
        edits: { "src/t1.ts": "// t1\n", "test/t1.test.ts": "// test\n" },
      },
      {
        reply: "Worker passed verify",
        edits: { "src/t1.ts": "// t1\n", "test/t1.test.ts": "// test\n" },
      },
      {
        reply: "Worker passed verify",
        edits: { "src/t2.ts": "// t2\n", "test/t2.test.ts": "// test\n" },
      },
    ]);

    // 1. Run baseline to get the sequence of events
    const baselineResult = await resumeAfterCrash(baselineRunId, {
      cwd: env.repoRoot,
      prompt: "Execute chaos test baseline",
      mode: "plan",
      permission_mode: "bypassPermissions",
      adapter: baselineClaude.adapter,
    });

    expect(baselineResult.status).toBe("finished");
    expect(baselineResult.exit_code).toBe(0);

    const baselineEvents = readEventLog(env.runDir, baselineRunId);
    const N = baselineEvents.length;
    expect(N).toBeGreaterThan(0);

    // 2. For each sequence boundary k in 1..N, execute fresh run, crash after event k, then resume to completion
    for (let k = 1; k <= N; k++) {
      const runId: RunId = createRunId();
      writePlanFiles(
        env.repoRoot,
        runId,
        { ...manifest, run_id: runId },
        { "tasks/T1.md": t1Spec, "tasks/T2.md": t2Spec },
        { "contracts/types.ts": sampleValidContractStub() }
      );

      // Each iteration can consume up to one planner call in the crashed run plus one in
      // the resumed run and one call per task; the calls are interchangeable because the
      // finish line and the file writes are what the engine checks. T1 and T2 are independent,
      // so with concurrency.workers 3 (R8.3) both can be in flight at the cut, and the resumed
      // run then needs a call for each of them: two spare worker calls cover that.
      const claude = fakeClaudeAdapter([
        {
          reply: "wrote manifest.yaml and the task specs\nPLAN READY",
          edits: { "src/t1.ts": "// t1\n", "test/t1.test.ts": "// test\n" },
        },
        {
          reply: "wrote the corrected plan\nPLAN READY",
          edits: { "src/t2.ts": "// t2\n", "test/t2.test.ts": "// test\n" },
        },
        {
          reply: "Worker passed verify",
          edits: { "src/t1.ts": "// t1\n", "test/t1.test.ts": "// test\n" },
        },
        {
          reply: "Worker passed verify",
          edits: { "src/t2.ts": "// t2\n", "test/t2.test.ts": "// test\n" },
        },
        {
          reply: "Worker passed verify",
          edits: { "src/t1.ts": "// t1\n", "test/t1.test.ts": "// test\n" },
        },
        {
          reply: "Worker passed verify",
          edits: { "src/t2.ts": "// t2\n", "test/t2.test.ts": "// test\n" },
        },
      ]);

      // Run until event k and crash
      const crashInfo = await runUntilBoundaryAndCrash(
        {
          cwd: env.repoRoot,
          prompt: "Execute chaos crash test",
          mode: "plan",
          permission_mode: "bypassPermissions",
          adapter: claude.adapter,
        },
        k
      );

      expect(crashInfo.crashedSeq).toBe(k);

      // Verify that events.jsonl exists and contains exactly k events
      const eventsBeforeResume = readEventLog(env.runDir, runId);
      expect(eventsBeforeResume.length).toBe(k);
      expect(eventsBeforeResume[eventsBeforeResume.length - 1].seq).toBe(k);

      // Pure reducer check: replaying events 1..k produces deterministic state
      let replayedState: EngineState = {
        run_id: runId,
        state: "CREATED",
        tasks: {},
        usage: { total_usd: 0, by_role: {} },
        checkpoints: [],
      };
      for (const ev of eventsBeforeResume) {
        replayedState = reduce(replayedState, ev);
      }
      expect(replayedState.run_id).toBe(runId);

      // Resume from crash to final finish
      const resumedSummary = await resumeAfterCrash(runId, {
        cwd: env.repoRoot,
        adapter: claude.adapter,
      });

      expect(resumedSummary.status).toBe("finished");
      expect(resumedSummary.exit_code).toBe(0);
      expect(resumedSummary.tasks.T1?.state).toBe("PASSED");
      expect(resumedSummary.tasks.T2?.state).toBe("PASSED");

      // Verify all events after resume form a strictly monotonic sequence
      const eventsAfterResume = readEventLog(env.runDir, runId);
      expect(eventsAfterResume.length).toBeGreaterThanOrEqual(k);
      for (let i = 0; i < eventsAfterResume.length; i++) {
        expect(eventsAfterResume[i].seq).toBe(i + 1);
      }

      claude.cleanup();
    }

    baselineClaude.cleanup();
  }, 120000);
});
