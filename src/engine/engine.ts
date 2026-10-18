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
import { FakeAdapter } from "../../test/conformance/fake-adapter.js";
import { type EngineState, reduce } from "./reducer.js";
import {
  type EffectContext,
  runEffectsLoop,
  appendRunEvent,
  readAllRunEvents,
} from "./effects.js";
import { RunLockImpl } from "../store/run-lock.js";
import { getRunBranch } from "../git/index.js";
import { log } from "../util/log.js";

export interface EngineOptions {
  settings?: Settings;
  adapter?: HarnessAdapter;
}

function generateRunId(): RunId {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let id = "r_";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id as RunId;
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
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...(this.options.settings ?? {}),
      ...(opts.overrides ?? {}),
    };

    const adapter: HarnessAdapter =
      this.options.adapter ?? new FakeAdapter();

    const runsDir = path.join(repoRoot, ".substrate", "runs");
    const candidateId = findExistingUnstartedRun(runsDir);
    const runId: RunId = candidateId ?? generateRunId();

    const lock = new RunLockImpl(runId, { baseDir: repoRoot });
    const acquired = await lock.acquire();
    if (!acquired) {
      throw new Error(
        `Failed to acquire run lock for run ${runId}: active lock exists`
      );
    }

    const heartbeatTimer = setInterval(() => {
      lock.heartbeat().catch(() => {});
    }, 5000);

    const runDir = path.join(repoRoot, ".substrate", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });

    const ctx: EffectContext = {
      runId,
      repoRoot,
      runDir,
      settings,
      adapter,
      signal: opts.signal,
      onEvent: opts.onEvent,
      prompt: opts.prompt,
      mode: opts.mode,
      permission_mode: opts.permission_mode,
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

      appendRunEvent(runDir, createdEvt);
      opts.onEvent?.(createdEvt);
      state = reduce(state, createdEvt);

      log.debug("[DEBUG] engine.run: entering runEffectsLoop, state:", state.state);
      state = await runEffectsLoop(ctx, state);
      log.debug("[DEBUG] engine.run: exited runEffectsLoop, state:", state.state);

      let finalStatus: "finished" | "paused" | "failed" | "cancelled" = "finished";
      let finalExitCode = 0;

      if (state.state === "FINISHED") {
        finalStatus = "finished";
        finalExitCode = 0;
      } else if (state.state === "PAUSED") {
        finalStatus = "paused";
        if (state.pause_reason === "budget_exhausted") {
          finalExitCode = 4;
        } else if (
          state.pause_reason === "permission_denied" ||
          state.pause_reason === "needs_human" ||
          state.pause_reason === "needs_approval" ||
          state.pause_reason === "rate_limited"
        ) {
          finalExitCode = 3;
        } else if (state.pause_reason === "user_cancel") {
          finalExitCode = 130;
        } else {
          finalExitCode = 3;
        }
      } else if (state.state === "FAILED") {
        finalStatus = "failed";
        finalExitCode = 1;
      } else if (state.state === "CANCELLED") {
        finalStatus = "cancelled";
        finalExitCode = 1;
      }

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

      return {
        run_id: runId,
        status: finalStatus,
        ...(state.pause_reason ? { pause_reason: state.pause_reason } : {}),
        tasks: summaryTasks,
        usage: state.usage,
        branch: getRunBranch(runId),
        exit_code: finalExitCode,
      };
    } finally {
      clearInterval(heartbeatTimer);
      await lock.release();
    }
  }

  async resume(runId: RunId, opts?: Partial<RunOptions>): Promise<RunSummary> {
    const repoRoot = opts?.cwd ?? process.cwd();
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...(this.options.settings ?? {}),
      ...(opts?.overrides ?? {}),
    };

    const adapter: HarnessAdapter =
      this.options.adapter ?? new FakeAdapter();

    const lock = new RunLockImpl(runId, { baseDir: repoRoot });
    const acquired = await lock.acquire();
    if (!acquired) {
      throw new Error(
        `Failed to acquire run lock for run ${runId}: active lock exists`
      );
    }

    const heartbeatTimer = setInterval(() => {
      lock.heartbeat().catch(() => {});
    }, 5000);

    const runDir = path.join(repoRoot, ".substrate", "runs", runId);

    const ctx: EffectContext = {
      runId,
      repoRoot,
      runDir,
      settings,
      adapter,
      signal: opts?.signal,
      onEvent: opts?.onEvent,
      prompt: opts?.prompt,
      mode: opts?.mode,
      permission_mode: opts?.permission_mode,
    };

    try {
      const existingEvents = readAllRunEvents(runDir);
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

      if (state.state === "PAUSED") {
        const nextSeq = existingEvents.length + 1;
        const resumedEvt: EngineEvent = {
          v: 1,
          seq: nextSeq,
          ts: new Date().toISOString(),
          run_id: runId,
          type: "run.resumed",
          data: {},
        };
        appendRunEvent(runDir, resumedEvt);
        opts?.onEvent?.(resumedEvt);
        state = reduce(state, resumedEvt);
      }

      state = await runEffectsLoop(ctx, state);

      let finalStatus: "finished" | "paused" | "failed" | "cancelled" = "finished";
      let finalExitCode = 0;

      if (state.state === "FINISHED") {
        finalStatus = "finished";
        finalExitCode = 0;
      } else if (state.state === "PAUSED") {
        finalStatus = "paused";
        if (state.pause_reason === "budget_exhausted") {
          finalExitCode = 4;
        } else if (
          state.pause_reason === "permission_denied" ||
          state.pause_reason === "needs_human" ||
          state.pause_reason === "needs_approval" ||
          state.pause_reason === "rate_limited"
        ) {
          finalExitCode = 3;
        } else if (state.pause_reason === "user_cancel") {
          finalExitCode = 130;
        } else {
          finalExitCode = 3;
        }
      } else if (state.state === "FAILED") {
        finalStatus = "failed";
        finalExitCode = 1;
      } else if (state.state === "CANCELLED") {
        finalStatus = "cancelled";
        finalExitCode = 1;
      }

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

      return {
        run_id: runId,
        status: finalStatus,
        ...(state.pause_reason ? { pause_reason: state.pause_reason } : {}),
        tasks: summaryTasks,
        usage: state.usage,
        branch: getRunBranch(runId),
        exit_code: finalExitCode,
      };
    } finally {
      clearInterval(heartbeatTimer);
      await lock.release();
    }
  }
}

export function createEngine(opts?: EngineOptions): Engine {
  return new EngineImpl(opts);
}

export const engine: Engine = createEngine();
