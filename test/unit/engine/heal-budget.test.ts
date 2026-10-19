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

describe("R3.4 unit: budgets, run budget warning once, rate limit backoff", () => {
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

  it("a per-task cost budget cuts only the task, not the run", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      budgets: {
        ...DEFAULT_SETTINGS.budgets,
        run: { max_usd: 10 },
        task: { max_usd: 0.002 },
      },
    };

    const result = await runWorkerAction({
      settings,
      configs: [{ events: [startedEvent(), usageEvent(0.01, 100)] }],
      // The per-task limit is the spec's own budget.
      specMarkdown: specWith({ protected: [], budget: { max_usd: 0.002 } }),
      concurrency: 4,
    });

    const failed = result.byType("task.failed");
    expect(failed).toHaveLength(1);
    expect((failed[0].data as any).failure_class).toBe("budget_exceeded");
    expect((failed[0].data as any).attempt).toBe(1);

    // The run is not paused by a per-task budget.
    expect(result.byType("run.paused")).toHaveLength(0);
    expect(result.adapter.killCalls.map((k) => k.reason)).toEqual(["budget"]);
  });

  it("a per-task turn budget cuts the task on the assistant turns of the generation", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      budgets: {
        ...DEFAULT_SETTINGS.budgets,
        run: { max_usd: 10 },
        task: { max_usd: 5, max_turns: 2 },
      },
    };

    const result = await runWorkerAction({
      settings,
      configs: [
        {
          events: [
            startedEvent(),
            usageEvent(0.01, 100),
            textEvent(),
            textEvent(),
            textEvent(),
          ],
        },
      ],
      // Without a spec budget the settings task budget is the per-task limit.
      specMarkdown: specWith({ protected: [], budget: undefined }),
      concurrency: 4,
    });

    const failed = result.byType("task.failed");
    expect(failed).toHaveLength(1);
    expect((failed[0].data as any).failure_class).toBe("budget_exceeded");
    expect(String((failed[0].data as any).detail)).toContain("turns");
    expect(result.byType("run.paused")).toHaveLength(0);
  });

  it("the 80 percent run budget warning for cost is emitted once", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      budgets: {
        ...DEFAULT_SETTINGS.budgets,
        run: { max_usd: 1 },
        task: { max_usd: 5 },
      },
    };

    const result = await runWorkerAction({
      settings,
      configs: [
        {
          events: [
            startedEvent(),
            usageEvent(0.5, 10),
            usageEvent(0.4, 10), // 0.9, past 80 percent: the warning fires
            usageEvent(0.05, 10), // still past 80 percent: no second warning
            usageEvent(0.1, 10), // 1.0: exceeded, the run pauses
          ],
        },
      ],
      // Only the run budget is in play here, so the task budget must not be crossed.
      specMarkdown: specWith({ protected: [], budget: undefined }),
      concurrency: 4,
    });

    const warnings = result.byType("run.budget.warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0].data as any).cost_usd).toBeCloseTo(0.9);

    const exceeded = result.byType("run.budget.exceeded");
    expect(exceeded).toHaveLength(1);
    const paused = result.byType("run.paused");
    expect(paused).toHaveLength(1);
    expect((paused[0].data as any).reason).toBe("budget_exhausted");
  });

  it("the 80 percent run budget warning for tokens is emitted once", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      budgets: {
        ...DEFAULT_SETTINGS.budgets,
        run: { max_usd: 10, max_tokens: 1000 },
        task: { max_usd: 5, max_tokens: 100000 },
      },
    };

    const result = await runWorkerAction({
      settings,
      configs: [
        {
          events: [
            startedEvent(),
            usageEvent(0.01, 400),
            usageEvent(0.01, 500), // 900 tokens, past 80 percent
            usageEvent(0.01, 50), // still past 80 percent: no second warning
            usageEvent(0.01, 50), // 1000 tokens: exceeded
          ],
        },
      ],
      // Only the run token budget is in play here.
      specMarkdown: specWith({ protected: [], budget: undefined }),
      concurrency: 4,
    });

    const warnings = result.byType("run.budget.warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0].data as any).tokens).toBe(900);
    expect((warnings[0].data as any).max_tokens).toBe(1000);

    const exceeded = result.byType("run.budget.exceeded");
    expect(exceeded).toHaveLength(1);
    expect((exceeded[0].data as any).tokens).toBe(1000);
    const paused = result.byType("run.paused");
    expect(paused).toHaveLength(1);
    expect((paused[0].data as any).reason).toBe("budget_exhausted");
  });

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

    // The copy keeps the rest of the settings, so the scheduler still sees the budgets.
    const budgetState: EngineState = {
      ...state,
      usage: {
        total_usd: 10,
        by_role: {},
      },
    };
    const budgetSettings: Settings = {
      ...settings,
      budgets: { ...settings.budgets, run: { max_usd: 10 } },
    };
    expect(nextActions(budgetState, budgetSettings, { concurrency: 1 })).toEqual([
      { type: "abort", reason: "budget" },
    ]);
  });
});
