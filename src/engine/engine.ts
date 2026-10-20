import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type {
  Engine,
  EngineEvent,
  FailureClass,
  HarnessAdapter,
  PauseReason,
  PermissionMode,
  RunId,
  RunOptions,
  RunSummary,
  Settings,
  TaskId,
} from "../contracts/index.js";
import { DEFAULT_SETTINGS } from "../config/index.js";
import { createAdapters, type AdapterMap } from "../backends/registry.js";
import { type EngineState, type RunState, reduce } from "./reducer.js";
import { type EffectContext, runEffectsLoop } from "./effects.js";
import { EventStoreImpl } from "../store/event-store.js";
import { RunLockImpl, RunLockError } from "../store/run-lock.js";
import { getRunBranch } from "../git/index.js";
import { deepMerge } from "../util/merge.js";
import { createRunId } from "../util/index.js";
import { log } from "../util/log.js";

export interface EngineOptions {
  settings?: Settings;
  adapter?: HarnessAdapter;
  adapters?: AdapterMap;
}

// Run ids must satisfy the RunId schema the event store validates, so the shared
// base32 generator is used rather than a local alphabet.
function generateRunId(): RunId {
  return createRunId() as RunId;
}

function findExistingUnstartedRun(runsDir: string): RunId | undefined {
  if (!fs.existsSync(runsDir)) return undefined;
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const candidates: { id: RunId; mtime: number }[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("r_")) {
      const manifestPath = path.join(runsDir, entry.name, "manifest.yaml");
      const eventsPath = path.join(runsDir, entry.name, "events.jsonl");
      if (fs.existsSync(manifestPath) && !fs.existsSync(eventsPath)) {
        try {
          const content = fs.readFileSync(manifestPath, "utf8");
          const parsed = YAML.parse(content);
          const runId = parsed?.run_id || entry.name;
          const stat = fs.statSync(manifestPath);
          candidates.push({ id: runId as RunId, mtime: stat.mtimeMs });
        } catch {
          candidates.push({ id: entry.name as RunId, mtime: 0 });
        }
      }
    }
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].id;
}

type RunSummaryStatus = "finished" | "paused" | "failed" | "cancelled";

function statusForState(runState: RunState): RunSummaryStatus {
  switch (runState) {
    case "FINISHED":
      return "finished";
    case "PAUSED":
      return "paused";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      throw new Error(`cannot report a run as finished from state ${runState}`);
  }
}

// Exit codes from the run's state (rule 7). There is no default: a run that is
// not in a terminal state is not summarised.
function exitCodeForState(runState: RunState, pauseReason?: PauseReason): number {
  switch (runState) {
    case "FINISHED":
      return 0;
    case "FAILED":
      return 1;
    case "CANCELLED":
      return 1;
    case "PAUSED":
      if (pauseReason === "budget_exhausted") return 4;
      if (pauseReason === "user_cancel") return 130;
      return 3;
    default:
      throw new Error(`cannot report a run as finished from state ${runState}`);
  }
}

function buildSummary(runId: RunId, state: EngineState): RunSummary {
  const summaryTasks: Record<
    TaskId,
    { state: string; generation: number; failure_class?: FailureClass }
  > = {};

  for (const [id, t] of Object.entries(state.tasks)) {
    let taskStateStr = t.state;
    if (t.state === "MERGED" || t.state === "PASSED") {
      taskStateStr = "PASSED";
    } else if (t.failure_class || t.state === "BLOCKED" || t.state === "REPLANNING") {
      taskStateStr = "FAILED";
    }
    summaryTasks[id as TaskId] = {
      state: taskStateStr,
      generation: t.generation ?? 1,
      ...(t.failure_class ? { failure_class: t.failure_class } : {}),
    };
  }

  const status = statusForState(state.state);
  const exitCode = exitCodeForState(state.state, state.pause_reason);

  return {
    run_id: runId,
    status,
    ...(state.pause_reason ? { pause_reason: state.pause_reason } : {}),
    tasks: summaryTasks,
    usage: state.usage,
    branch: getRunBranch(runId),
    exit_code: exitCode,
  };
}

export class EngineImpl implements Engine {
  private readonly options: EngineOptions;

  constructor(opts?: EngineOptions) {
    this.options = opts ?? {};
  }

  async run(opts: RunOptions): Promise<RunSummary> {
    if (opts.resume) {
      return this.resume(opts.resume, opts);
    }

    const repoRoot = opts.cwd;
    const settings: Settings = deepMerge(
      deepMerge(DEFAULT_SETTINGS, this.options.settings ?? {}),
      opts.overrides ?? {},
    );

    const defaultAdapters = this.options.adapter
      ? {
          claude: this.options.adapter,
          opencode: this.options.adapter,
          agy: this.options.adapter,
        }
      : createAdapters(settings);

    const adapters: AdapterMap = {
      ...defaultAdapters,
      ...this.options.adapters,
    };

    const runsDir = path.join(repoRoot, ".substrate", "runs");
    const candidateId = findExistingUnstartedRun(runsDir);
    const runId: RunId = candidateId ?? generateRunId();

    const lock = new RunLockImpl(runId, { baseDir: repoRoot });
    const acquired = await lock.acquire();
    if (!acquired) {
      throw new RunLockError(runId, lock.holderPid());
    }

    const heartbeatTimer = setInterval(() => {
      lock.heartbeat().catch(() => {});
    }, 5000);

    const runDir = path.join(repoRoot, ".substrate", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });

    const store = new EventStoreImpl(runId, { baseDir: repoRoot });

    const ctx: EffectContext = {
      runId,
      repoRoot,
      runDir,
      settings,
      adapters,
      concurrency: settings.concurrency.workers,
      signal: opts.signal,
      onEvent: opts.onEvent,
      prompt: opts.prompt,
      mode: opts.mode,
      permission_mode: opts.permission_mode,
      store,
    };

    let state: EngineState = {
      run_id: runId,
      state: "CREATED",
      tasks: {},
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };

    try {
      log.debug("[DEBUG] engine.run: creating run.created");
      const createdEvt: EngineEvent = {
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        run_id: runId,
        type: "run.created",
        data: {
          run_id: runId,
          prompt: opts.prompt,
          mode: opts.mode,
          permission_mode: opts.permission_mode,
        },
      };

      await store.append(createdEvt);
      opts.onEvent?.(createdEvt);
      state = reduce(state, createdEvt);

      log.debug("[DEBUG] engine.run: entering runEffectsLoop, state:", state.state);
      state = await runEffectsLoop(ctx, state);
      log.debug("[DEBUG] engine.run: exited runEffectsLoop, state:", state.state);

      return buildSummary(runId, state);
    } finally {
      clearInterval(heartbeatTimer);
      await lock.release();
    }
  }

  async resume(runId: RunId, opts?: Partial<RunOptions>): Promise<RunSummary> {
    const repoRoot = opts?.cwd ?? process.cwd();
    const settings: Settings = deepMerge(
      deepMerge(DEFAULT_SETTINGS, this.options.settings ?? {}),
      opts?.overrides ?? {},
    );

    const defaultAdapters = this.options.adapter
      ? {
          claude: this.options.adapter,
          opencode: this.options.adapter,
          agy: this.options.adapter,
        }
      : createAdapters(settings);

    const adapters: AdapterMap = {
      ...defaultAdapters,
      ...this.options.adapters,
    };

    const lock = new RunLockImpl(runId, { baseDir: repoRoot });
    const acquired = await lock.acquire();
    if (!acquired) {
      throw new RunLockError(runId, lock.holderPid());
    }

    const heartbeatTimer = setInterval(() => {
      lock.heartbeat().catch(() => {});
    }, 5000);

    const runDir = path.join(repoRoot, ".substrate", "runs", runId);

    const store = new EventStoreImpl(runId, { baseDir: repoRoot });

    const ctx: EffectContext = {
      runId,
      repoRoot,
      runDir,
      settings,
      adapters,
      concurrency: settings.concurrency.workers,
      signal: opts?.signal,
      onEvent: opts?.onEvent,
      prompt: opts?.prompt,
      mode: opts?.mode,
      permission_mode: opts?.permission_mode,
      store,
    };

    try {
      const existingEvents = await store.readAll();
      let state: EngineState = {
        run_id: runId,
        state: "CREATED",
        tasks: {},
        usage: { total_usd: 0, by_role: {} },
        checkpoints: [],
      };
      for (const evt of existingEvents) {
        state = reduce(state, evt);
      }

      let lastSeq = existingEvents.length > 0 ? existingEvents[existingEvents.length - 1].seq : 0;

      if (state.state === "PAUSED") {
        const resumedEvt: EngineEvent = {
          v: 1,
          seq: lastSeq + 1,
          ts: new Date().toISOString(),
          run_id: runId,
          type: "run.resumed",
          data: {},
        };
        await store.append(resumedEvt);
        lastSeq = resumedEvt.seq;
        opts?.onEvent?.(resumedEvt);
        state = reduce(state, resumedEvt);
      }

      // A task killed between task.session.started and task.session.ended is put
      // back in the queue; HEALING tasks keep their state.
      for (const task of Object.values(state.tasks)) {
        if (
          task.state !== "RUNNING" &&
          task.state !== "SCOPE_CHECK" &&
          task.state !== "VERIFYING"
        ) {
          continue;
        }
        const readyEvt: EngineEvent = {
          v: 1,
          seq: lastSeq + 1,
          ts: new Date().toISOString(),
          run_id: runId,
          type: "task.ready",
          data: { task_id: task.id, resumed: true },
        };
        await store.append(readyEvt);
        lastSeq = readyEvt.seq;
        opts?.onEvent?.(readyEvt);
        state = reduce(state, readyEvt);
      }

      state = await runEffectsLoop(ctx, state);

      return buildSummary(runId, state);
    } finally {
      clearInterval(heartbeatTimer);
      await lock.release();
    }
  }
}

export function createEngine(opts?: EngineOptions): Engine {
  return new EngineImpl(opts);
}

