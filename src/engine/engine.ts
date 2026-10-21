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
import { endStaleWorkers } from "../backends/worker-pids.js";
import { type EngineState, type RunState, reduce } from "./reducer.js";
import { commitContractStubs, ingestPlanDraft, planTasksForEvent } from "../roles/planner.js";
import { resolveBaseRef } from "../git/base-ref.js";
import { failRunOnInternalError, isInterruption, notifyObserver, observerCrashed } from "./internal-error.js";
import { type EffectContext, runEffectsLoop } from "./effects.js";
import { EventStoreImpl } from "../store/event-store.js";
import { RunLockImpl, RunLockError } from "../store/run-lock.js";
import { ensureGitExclude, getRunBranch, restoreTaskBranch } from "../git/index.js";
import { runBranchExists } from "../git/workspace.js";
import { deepMerge } from "../util/merge.js";
import { type RecordedRun, budgetRecord, recordedRunOptions, recordedSettingsOverrides, runInputsRecord } from "./recorded-run.js";
import { type TimeLimit, startTimeLimit, timeLimitSecondsOf } from "./time-limit.js";
import { currentBranchName } from "../git/landing.js";
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

type RunSummaryStatus = "finished" | "planned" | "paused" | "failed" | "cancelled";

function statusForState(runState: RunState): RunSummaryStatus {
  switch (runState) {
    case "FINISHED":
      return "finished";
    case "PLANNED":
      return "planned";
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
export function exitCodeForState(runState: RunState, pauseReason?: PauseReason): number {
  switch (runState) {
    case "FINISHED":
      return 0;
    // R10.5: a plan-only run is planned: nothing failed, so it exits 0.
    case "PLANNED":
      return 0;
    case "FAILED":
      return 1;
    case "CANCELLED":
      return 1;
    case "PAUSED":
      // R11.2: a run stopped by its time limit is a limit reached, like a budget stop.
      if (pauseReason === "budget_exhausted" || pauseReason === "timeout") return 4;
      if (pauseReason === "user_cancel") return 130;
      return 3;
    default:
      throw new Error(`cannot report a run as finished from state ${runState}`);
  }
}

export function buildSummary(runId: RunId, state: EngineState, repoRoot: string): RunSummary {
  const summaryTasks: Record<
    TaskId,
    { state: string; generation: number; failure_class?: FailureClass }
  > = {};

  for (const [id, t] of Object.entries(state.tasks)) {
    let taskStateStr: string = t.state;
    if (t.state === "MERGED" || t.state === "PASSED") {
      taskStateStr = "PASSED";
    } else if (t.state === "ABANDONED") {
      taskStateStr = "SKIPPED";
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
    // Named only when the branch exists, so the summary never points at a branch that is not there (R7.9).
    ...(runBranchExists(repoRoot, runId) ? { branch: getRunBranch(runId) } : {}),
    exit_code: exitCode,
  };
}

/**
 * R10.4: the run ended failed when its last run.finished has a non-zero exit and no run.reopened follows
 * it. A reopen after the failure means the run is open again.
 */
export function endedFailed(events: EngineEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i].type;
    if (type === "run.reopened") return false;
    if (type === "run.finished") {
      return ((events[i].data as { exit_code?: unknown } | undefined)?.exit_code ?? 1) !== 0;
    }
  }
  return false;
}

/** The run-directory files a planning session writes; an abandoned draft is these, moved aside together. */
const DRAFT_ITEMS = ["manifest.yaml", "tasks", "contracts", "QUESTIONS.md"];

/**
 * R10.5: moves an abandoned planning draft to `drafts-<n>/` in the run directory (moved, never deleted).
 * Returns the directory's name, or undefined when the run directory holds no draft.
 */
export function setAsideDraft(runDir: string): string | undefined {
  const items = DRAFT_ITEMS.filter((item) => fs.existsSync(path.join(runDir, item)));
  if (items.length === 0) return undefined;
  let n = 1;
  while (fs.existsSync(path.join(runDir, `drafts-${n}`))) n++;
  const name = `drafts-${n}`;
  fs.mkdirSync(path.join(runDir, name));
  for (const item of items) {
    fs.renameSync(path.join(runDir, item), path.join(runDir, name, item));
  }
  return name;
}

/**
 * R10.4: what a reopen does, from the log and the replayed state. No accepted plan means planning again;
 * a plan with no setup.done means setup again; otherwise the failed and skipped tasks go back to the queue.
 */
export function reopenData(
  events: EngineEvent[],
  state: EngineState,
): { reason: "planning" | "setup" | "tasks"; failed_tasks?: string[]; skipped_tasks?: string[]; kept_tasks?: string[] } {
  if (!events.some((e) => e.type === "plan.produced")) return { reason: "planning" };
  if (!events.some((e) => e.type === "setup.done")) return { reason: "setup" };
  const byState = (...states: string[]): string[] =>
    Object.values(state.tasks)
      .filter((t) => states.includes(t.state))
      .map((t) => t.id)
      .sort((a, b) => a.localeCompare(b));
  return {
    reason: "tasks",
    failed_tasks: byState("BLOCKED", "FAILED", "REPLANNING", "HEALING", "VERIFYING", "RUNNING", "SCOPE_CHECK"),
    skipped_tasks: byState("ABANDONED"),
    kept_tasks: byState("MERGED"),
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
    // `.substrate/` is the tool's own state; it is kept out of the user's `git status`.
    ensureGitExclude(repoRoot);

    const store = new EventStoreImpl(runId, { baseDir: repoRoot });

    // R11.2: the run's wall-clock limit starts with this process; the timer is cleared when the run returns.
    const timeLimit = startTimeLimit(timeLimitSecondsOf(settings));
    const ctx: EffectContext = {
      runId,
      repoRoot,
      runDir,
      settings,
      adapters,
      concurrency: settings.concurrency.workers,
      signal: opts.signal,
      timeout: timeLimit?.signal,
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
            // R8.2 (known issue 18): the models the caller named, kept so a resume uses them.
            ...(settings.roles.requested !== undefined ? { requested_roles: settings.roles.requested } : {}),
            // R10.1: the branch the run starts on; its work lands there only (detached: "HEAD").
            base_branch: currentBranchName(repoRoot),
            // R10.3: the landing and the worker count in effect, so a resume keeps them.
            merge: opts.merge ?? settings.git?.auto_merge === true,
            concurrency: settings.concurrency.workers,
            // R11.1: the run budget and the run-level lists in effect, so a resume keeps them.
            ...runInputsRecord(settings, opts.overrides),
          },
        };

        await store.append(createdEvt);
        notifyObserver(ctx, createdEvt);
        state = reduce(state, createdEvt);

        log.debug("[DEBUG] engine.run: entering runEffectsLoop, state:", state.state);
        state = await runEffectsLoop(ctx, state);
        log.debug("[DEBUG] engine.run: exited runEffectsLoop, state:", state.state);
      } catch (error: unknown) {
        // R9.1 (known issue 45): an unexpected exception ends the run as failed, cleanly.
        if (isInterruption(error) || observerCrashed(ctx)) throw error;
        state = await failRunOnInternalError(ctx, state, error);
      }

      return buildSummary(runId, state, repoRoot);
    } finally {
      timeLimit?.clear();
      clearInterval(heartbeatTimer);
      await lock.release();
    }
  }

  async resume(runId: RunId, opts?: Partial<RunOptions>): Promise<RunSummary> {
    const repoRoot = opts?.cwd ?? process.cwd();

    const lock = new RunLockImpl(runId, { baseDir: repoRoot });
    const acquired = await lock.acquire();
    if (!acquired) {
      throw new RunLockError(runId, lock.holderPid());
    }

    const heartbeatTimer = setInterval(() => {
      lock.heartbeat().catch(() => {});
    }, 5000);

    const runDir = path.join(repoRoot, ".substrate", "runs", runId);

    ensureGitExclude(repoRoot);
    // R8.2: a worker a killed CLI left running is ended now, while this run holds the lock.
    endStaleWorkers(runDir);

    const store = new EventStoreImpl(runId, { baseDir: repoRoot });

    let state: EngineState | undefined;
    let timeLimit: TimeLimit | undefined;
    try {
      // R11.1: the inputs the run was created with come from its own run.created event, so a resume does
      // not rebuild the request, the budget or the lists from its options. An unreadable log is reported
      // by the run's own error handling below.
      let recorded: RecordedRun = {};
      try {
        store.repairTornTail();
        recorded = recordedRunOptions(await store.readAll());
      } catch {
        recorded = {};
      }
      const settings: Settings = deepMerge(
        deepMerge(deepMerge(DEFAULT_SETTINGS, this.options.settings ?? {}), recordedSettingsOverrides(recorded)),
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

      // R11.2: a resume starts a fresh clock with the limit it has (the recorded one, or --timeout given again).
      timeLimit = startTimeLimit(timeLimitSecondsOf(settings));
      const ctx: EffectContext = {
        runId,
        repoRoot,
        runDir,
        settings,
        adapters,
        concurrency: settings.concurrency.workers,
        signal: opts?.signal,
        timeout: timeLimit?.signal,
        onEvent: opts?.onEvent,
        prompt: opts?.prompt ?? recorded.prompt,
        mode: (opts?.mode ?? recorded.mode) as RunOptions["mode"],
        permission_mode: (opts?.permission_mode ?? recorded.permission_mode) as RunOptions["permission_mode"],
        store,
      };

      try {
        // R10.5: a torn last line from a killed CLI is dropped before this resume appends anything.
        store.repairTornTail();
        const existingEvents = await store.readAll();
        state = {
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
            // R11.1: the budget this resume uses, recorded again so a later resume keeps it.
            data: { ...budgetRecord(settings) },
          };
          await store.append(resumedEvt);
          lastSeq = resumedEvt.seq;
          notifyObserver(ctx, resumedEvt);
          state = reduce(state, resumedEvt);
        }

        // R10.5: a run with no accepted plan (planning was stopped, or planning failed). A complete draft the
        // earlier session left in the run directory is ingested and accepted as if the planner had just
        // produced it, and the planner is not called. Any other draft is moved to drafts-<n>/ and the run is
        // planned again. A run that asked the user a question is left to the planner's own answer path.
        const appended: EngineEvent[] = [];
        const emit = async (type: EngineEvent["type"], data: Record<string, unknown>): Promise<void> => {
          lastSeq += 1;
          const evt = { v: 1, seq: lastSeq, ts: new Date().toISOString(), run_id: runId, type, data } as EngineEvent;
          await store.append(evt);
          appended.push(evt);
          notifyObserver(ctx, evt);
          state = reduce(state as EngineState, evt);
        };
        let keptDraft: string | undefined;
        const askedQuestions = existingEvents.some(
          (e) => e.type === "run.paused" && (e.data as { reason?: unknown } | undefined)?.reason === "needs_human",
        );
        if (!existingEvents.some((e) => e.type === "plan.produced") && !askedQuestions) {
          const ingested = fs.existsSync(path.join(runDir, "manifest.yaml"))
            ? await ingestPlanDraft({ runDir, repoRoot, settings })
            : undefined;
          if (ingested?.ok) {
            const base = resolveBaseRef(repoRoot, ingested.manifest.base_ref);
            const commitSha = await commitContractStubs(
              repoRoot,
              runId,
              base.sha,
              ingested.manifest.contracts,
              runDir,
            );
            await emit("contracts.committed", { commit_sha: commitSha, ...(base.note ? { note: base.note } : {}) });
            await emit("plan.produced", {
              manifest: ingested.manifest,
              tasks: planTasksForEvent(ingested.manifest, ingested.plan.specs),
              commit_sha: commitSha,
              source: "draft",
            });
          } else {
            keptDraft = setAsideDraft(runDir);
            // A run that did not end failed is reopened here; a failed one is reopened below, which names the kept draft.
            if (!endedFailed(existingEvents)) {
              await emit("run.reopened", {
                reason: "planning",
                ...(keptDraft !== undefined ? { draft_dir: keptDraft } : {}),
                ...budgetRecord(settings),
              });
            }
          }
        }

        // R10.4 (known issue 41, reversed): a run that ended failed is reopened, not refused. Planning
        // is not repeated when a plan was accepted; the failed tasks retry as a new generation.
        if (endedFailed(existingEvents) && !appended.some((e) => e.type === "run.reopened")) {
          await emit("run.reopened", {
            ...reopenData([...existingEvents, ...appended], state),
            ...(keptDraft !== undefined ? { draft_dir: keptDraft } : {}),
            ...budgetRecord(settings),
          });
        }

        // R10.5: a planned run (planned by `plan` or `run --review`) takes the plan the person reviewed. The
        // manifest and specs are ingested again (they may have been edited), the contracts are committed again,
        // and plan.produced replaces the task set; the run then lints, sets up and runs its tasks as usual.
        if (state.state === "PLANNED") {
          const reviewed = await ingestPlanDraft({ runDir, repoRoot, settings });
          if (!reviewed.ok) {
            throw new Error(`the reviewed plan does not pass: ${reviewed.diagnostics.join("; ")}`);
          }
          await emit("run.reopened", { reason: "plan_review", ...budgetRecord(settings) });
          const base = resolveBaseRef(repoRoot, reviewed.manifest.base_ref);
          const commitSha = await commitContractStubs(repoRoot, runId, base.sha, reviewed.manifest.contracts, runDir);
          await emit("contracts.committed", { commit_sha: commitSha, ...(base.note ? { note: base.note } : {}) });
          await emit("plan.produced", {
            manifest: reviewed.manifest,
            tasks: planTasksForEvent(reviewed.manifest, reviewed.plan.specs),
            commit_sha: commitSha,
            source: "review",
          });
        }

        // A task killed between task.session.started and task.session.ended is put
        // back in the queue; HEALING tasks keep their state.
        for (const task of Object.values(state.tasks)) {
          // A PASSED or MERGING task keeps its place when its branch is there, or can be
          // rebuilt from the run branch (R8.1); otherwise its work is gone and it runs again.
          const passedWork = task.state === "PASSED" || task.state === "MERGING";
          if (passedWork && restoreTaskBranch(repoRoot, runId, task.id, task.generation ?? 1)) {
            continue;
          }
          if (
            !passedWork &&
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
          notifyObserver(ctx, readyEvt);
          state = reduce(state, readyEvt);
        }

        // R10.1: a crash after integration verify passed, before run.finished, leaves a FINISHED
        // state with no run.finished in the log. The resume writes it, so the log and the landing
        // see the run as finished.
        if (state.state === "FINISHED" && !existingEvents.some((e) => e.type === "run.finished")) {
          const finishedEvt: EngineEvent = {
            v: 1,
            seq: lastSeq + 1,
            ts: new Date().toISOString(),
            run_id: runId,
            type: "run.finished",
            data: { exit_code: 0 },
          };
          await store.append(finishedEvt);
          lastSeq = finishedEvt.seq;
          notifyObserver(ctx, finishedEvt);
          state = reduce(state, finishedEvt);
        }

        state = await runEffectsLoop(ctx, state);
      } catch (error: unknown) {
        // R9.1 (known issue 45): an unexpected exception ends the run as failed, cleanly.
        if (isInterruption(error) || observerCrashed(ctx)) throw error;
        state = await failRunOnInternalError(ctx, state, error);
      }

      return buildSummary(runId, state, repoRoot);
    } finally {
      timeLimit?.clear();
      clearInterval(heartbeatTimer);
      await lock.release();
    }
  }
}

export function createEngine(opts?: EngineOptions): Engine {
  return new EngineImpl(opts);
}

