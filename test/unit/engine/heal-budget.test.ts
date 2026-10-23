import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

import type { EngineState } from "../../../src/engine/reducer.js";
import type {
  BackendEvent,
  EngineEvent,
  RunId,
  Settings,
  TaskId,
  UsageRecord,
} from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { makeEmitter } from "../../../src/engine/emit.js";
import { nextActions } from "../../../src/engine/effects.js";
import type { EffectContext } from "../../../src/engine/effects.js";
import { runTaskAction } from "../../../src/engine/actions/task.js";
import { workspaceManager } from "../../../src/git/index.js";
import type { AdapterMap } from "../../../src/backends/registry.js";
import {
  createMockAdapter,
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
  type MockSessionConfig,
} from "../../integration/roles/fixtures.js";
import {
  setupScenarioEnv,
  writePlanFiles,
  type ScenarioEnv,
} from "../../integration/scenarios/helpers.js";

const RUN_ID: RunId = "r_AAAAABBBBBBB";
const TASK_ID: TaskId = "T1";

function usageRecord(cost: number, tokens: number): UsageRecord {
  return {
    backend: "claude",
    model: "claude-sonnet-5-5",
    input_tokens: tokens,
    output_tokens: 0,
    cost_usd: cost,
    cost_source: "computed",
    at: new Date().toISOString(),
  };
}

function usageEvent(cost: number, tokens: number): BackendEvent {
  return { type: "usage", record: usageRecord(cost, tokens), cumulative: false };
}

function startedEvent(): BackendEvent {
  return { type: "session.started", session_id: "session-1" };
}

function textEvent(): BackendEvent {
  return { type: "assistant.text", text: "working" };
}

function rateLimitEvent(): BackendEvent {
  return { type: "error", kind: "rate_limit", message: "backend rate limit" };
}

describe("R3.4 unit: rate limit backoff and the copy of the settings", () => {
  let env: ScenarioEnv;

  beforeEach(async () => {
    env = await setupScenarioEnv("heal-budget");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function runWorkerAction(options: {
    settings: Settings;
    configs: MockSessionConfig[];
    specMarkdown: string;
    concurrency: number;
  }) {
    const adapter = createMockAdapter({ sessionConfigs: options.configs });
    const runDir = join(env.runDir, RUN_ID);

    writePlanFiles(env.repoRoot, RUN_ID, sampleValidManifest(RUN_ID), {
      "tasks/T1.md": options.specMarkdown,
    });
    await workspaceManager.createRunBranch(env.repoRoot, RUN_ID, "main");

    const ctx: EffectContext = {
      runId: RUN_ID,
      repoRoot: env.repoRoot,
      runDir,
      settings: options.settings,
      adapters: { claude: adapter } as AdapterMap,
      concurrency: options.concurrency,
    };

    const state: EngineState = {
      run_id: RUN_ID,
      state: "EXECUTING",
      tasks: { [TASK_ID]: { id: TASK_ID, state: "RUNNING", generation: 1, attempt: 1 } },
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };

    const { events, emit } = makeEmitter(ctx, state);
    await runTaskAction({ type: "worker", taskId: TASK_ID }, ctx, state, emit);

    return {
      events,
      ctx,
      adapter,
      byType: (type: string) => events.filter((e) => e.type === type),
    };
  }

  function specWith(frontmatter: Record<string, unknown>): string {
    return sampleValidTaskSpecMarkdown({ frontmatter });
  }

  it(
    "rate limits back off 1000, 2000 and 4000 ms, halve concurrency on a copy, and the " +
      "fourth one ends the task and pauses the run",
    async () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        concurrency: { workers: 8 },
      };

      const configs: MockSessionConfig[] = [1, 2, 3, 4].map(() => ({
        events: [startedEvent(), rateLimitEvent()],
      }));

      const result = await runWorkerAction({
        settings,
        configs,
        specMarkdown: specWith({ protected: [] }),
        concurrency: settings.concurrency.workers,
      });

      const backoffs = result.byType("rate_limit.backoff");
      expect(backoffs).toHaveLength(4);
      expect(backoffs.map((e) => (e.data as any).concurrency)).toEqual([4, 2, 1, 1]);

      // The delays are the backoff, measured between consecutive backoff events.
      const gaps = backoffs.slice(1).map(
        (e, i) => new Date(e.ts).getTime() - new Date(backoffs[i].ts).getTime()
      );
      expect(gaps[0]).toBeGreaterThanOrEqual(950);
      expect(gaps[1]).toBeGreaterThanOrEqual(1950);
      expect(gaps[2]).toBeGreaterThanOrEqual(3950);

      // The same attempt is retried, so the attempt number is not consumed.
      expect(result.adapter.spawnedRequests).toHaveLength(4);
      const failed = result.byType("task.failed");
      expect(failed).toHaveLength(1);
      expect((failed[0].data as any).failure_class).toBe("rate_limited");
      expect((failed[0].data as any).attempt).toBe(1);

      const paused = result.byType("run.paused");
      expect(paused).toHaveLength(1);
      expect((paused[0].data as any).reason).toBe("rate_limited");

      // Halving lives on the run's effective context, never on the settings object.
      expect(result.ctx.concurrency).toBe(1);
      expect(result.ctx.settings.concurrency.workers).toBe(8);
      expect(result.adapter.killCalls.map((k) => k.reason)).toEqual([
        "cancel",
        "cancel",
        "cancel",
        "cancel",
      ]);
    },
    20000
  );

  it("pauses at the fourth rate limit when concurrency is already at the floor", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      concurrency: { workers: 1 },
    };

    const result = await runWorkerAction({
      settings,
      configs: [{ events: [startedEvent(), rateLimitEvent()] }],
      specMarkdown: specWith({ protected: [] }),
      concurrency: 1,
    });

    const backoffs = result.byType("rate_limit.backoff");
    expect(backoffs).toHaveLength(1);
    expect((backoffs[0].data as any).concurrency).toBe(1);

    const paused = result.byType("run.paused");
    expect(paused).toHaveLength(1);
    expect((paused[0].data as any).reason).toBe("rate_limited");

    const failed = result.byType("task.failed");
    expect(failed).toHaveLength(1);
    expect((failed[0].data as any).failure_class).toBe("rate_limited");
  });

  it("nextActions schedules on the copy with the halved concurrency, not on settings", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      concurrency: { workers: 8 },
    };

    const state: EngineState = {
      run_id: RUN_ID,
      state: "EXECUTING",
      tasks: {
        T1: { id: "T1", state: "READY", generation: 1, attempt: 1 },
        T2: { id: "T2", state: "READY", generation: 1, attempt: 1 },
        T3: { id: "T3", state: "READY", generation: 1, attempt: 1 },
      },
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };

    const actions = nextActions(state, settings, { concurrency: 1 });
    expect(actions).toHaveLength(1);
    expect(settings.concurrency.workers).toBe(8);

  });
});
