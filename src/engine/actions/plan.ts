import fs from "node:fs";
import path from "node:path";

import type { EventData, EventType } from "../../contracts/events.js";
import type { Question, SpawnRequest } from "../../contracts/index.js";
import {
  PlannerFailure,
  PLANNER_PID_TASK,
  commitContractStubs,
  ingestPlanDraft,
  withoutRootPaths,
  finishLine,
  formatRejectedData,
  planTasksForEvent,
  planWarningsEventData,
  planWarningsOf,
  plannerBudgetMessage,
  plannerFailureMessage,
  plannerSpawnBudgetUsd,
  runPlanner,
  sessionFailureMessage,
  writePlanWarnings,
  type PlannerEmit,
} from "../../roles/planner.js";
import { resolvePlannerRoute } from "../../roles/router.js";
import { resolveBaseRef } from "../../git/base-ref.js";
import { clearWorkerPid, recordWorkerPid } from "../../backends/worker-pids.js";
import { toDelta, type UsageTotals } from "../../ledger/usage.js";
import { loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";
import { buildCorrectionPrompt } from "../../roles/prompts/planner.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget, interruptOf } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { adapterFor } from "./shared.js";
import { bindAbort } from "../../backends/process.js";
import { startHarnessSession } from "../../backends/spawn.js";
import { HarnessSpawnError } from "../../backends/process.js";
import { teeTranscript } from "../../store/transcript.js";
import { runLintAction } from "./approve.js";
import { log } from "../../util/log.js";
import { boundedMessage } from "../../util/index.js";
import { plannerCharter, plannerHistory } from "../../charter/index.js";

function isSafeRelativePath(p: string): boolean {
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  return !normalized.startsWith("..") && !path.isAbsolute(normalized);
}

function isSuppressedForRunDir(runDir: string, diag: any): boolean {
  if (diag.code !== "L003" && diag.code !== "L019" && diag.code !== "L027") return false;
  if (!diag.path) return false;
  if (!isSafeRelativePath(diag.path)) return false;
  return fs.existsSync(path.resolve(runDir, diag.path));
}

/**
 * The `plan` action: resolve the planner route, hand the planner the emitter so
 * its usage events are recorded while the session runs, and turn the planner's
 * outcome into events. The `lint` action belongs to approve.ts.
 */
export async function runPlanAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  if (action.type === "lint") {
    await runLintAction(action, ctx, state, emit);
    return;
  }

  emit("plan.started", {});

  const route = resolvePlannerRoute(ctx.settings);
  const adapter = adapterFor(ctx, route.backend);
  if (!adapter) {
    emit("run.paused", { reason: "backend_unavailable" });
    return;
  }

  const { parseQuestions, formatAnswers } = await import(`../../cli/questions.js`);

  let allEvents: any[] = [];
  if (ctx.store) {
    try {
      allEvents = await ctx.store.readAll();
    } catch {
      const eventsPath = path.join(ctx.runDir, "events.jsonl");
      if (fs.existsSync(eventsPath)) {
        for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            allEvents.push(JSON.parse(line));
          } catch {}
        }
      }
    }
  }
  const lastPaused = [...allEvents].reverse().find((e) => e.type === "run.paused");
  const lastResumed = [...allEvents].reverse().find((e) => e.type === "run.resumed");
  const hasAnswers =
    Boolean(lastPaused) &&
    Boolean(lastResumed) &&
    (lastResumed?.seq ?? 0) > (lastPaused?.seq ?? 0) &&
    (lastResumed?.data as any)?.answers !== undefined;

  let totalUsd = state.usage.total_usd;
  let stoppedForBudget = false;

  // Re-entry with answers: resume the planner session using planner/answers.md
  if (hasAnswers) {
    const pausedData = (lastPaused?.data ?? {}) as {
      session_id?: string;
      questions_path?: string;
      questions?: Question[];
    };
    const resumedData = (lastResumed?.data ?? {}) as {
      answers?: Array<{ id: string; text: string }>;
    };

    let questions = pausedData.questions ?? [];
    if (questions.length === 0 && pausedData.questions_path && fs.existsSync(pausedData.questions_path)) {
      try {
        questions = parseQuestions(fs.readFileSync(pausedData.questions_path, "utf8"));
      } catch {}
    }
    const answers = resumedData.answers ?? [];

    const initialPrompt = render(loadTemplate("planner/answers.md"), {
      answers: formatAnswers(questions, answers),
    });

    const oldQuestionsPath = path.resolve(ctx.runDir, "QUESTIONS.md");
    if (fs.existsSync(oldQuestionsPath)) {
      try {
        fs.unlinkSync(oldQuestionsPath);
      } catch {}
    }

    const maxAttempts = 1 + (ctx.settings.budgets?.planner_format_retries ?? 2);
    let attempt = 0;
    let currentSessionId = pausedData.session_id ?? "";
    let currentPrompt = initialPrompt;
    let diagnostics: string[] = [];
    let sessionTotals: UsageTotals | undefined;

    while (attempt < maxAttempts) {
      attempt++;
      if (attempt > 1) {
        emit("plan.format_rejected", formatRejectedData(attempt - 1, maxAttempts, diagnostics));
        currentPrompt = buildCorrectionPrompt({
          attempt,
          max_attempts: maxAttempts,
          diagnostics,
        }).user;
      }

      const spawnReq: SpawnRequest = {
        role: "planner",
        cwd: ctx.runDir,
        prompt: currentPrompt,
        model: route.model,
        ...(route.effort !== undefined ? { effort: route.effort } : {}),
        permission: {
          allow: [ctx.runDir],
          deny: [
            ".git",
            ".substrate",
            "node_modules",
            "package.json",
            "package-lock.json",
            "tsconfig.json",
          ],
        },
        budget: {
          // The planner is bounded by the run budget not yet spent, as in runPlanner (R7.9); no cap when the run has none.
          max_usd: plannerSpawnBudgetUsd(ctx.settings.budgets?.run?.max_usd, totalUsd),
          ...(ctx.settings.budgets?.task?.timeout_min
            ? { timeout_ms: ctx.settings.budgets.task.timeout_min * 60 * 1000 }
            : {}),
          ...(ctx.settings.budgets?.task?.max_tokens ? { max_tokens: ctx.settings.budgets.task.max_tokens } : {}),
          ...(ctx.settings.budgets?.task?.timeout_min ? { timeout_min: ctx.settings.budgets.task.timeout_min } : {}),
        },
        session: { resume: currentSessionId },
      };

      let handle;
      try {
        handle = await startHarnessSession(adapter, spawnReq);
      } catch (err) {
        // The planner never started (R13.1): the run fails as a planning failure that names the binary.
        if (!(err instanceof HarnessSpawnError)) throw err;
        emit("task.failed", { failure_class: "worker_crashed", message: boundedMessage(`the planner could not start: ${err.message}`) });
        emit("run.finished", { exit_code: 1, status: "failed" });
        return;
      }
      // R10.5: recorded like a worker's pid until the session ends (see endStaleWorkers).
      const pidRecord = { task_id: PLANNER_PID_TASK, generation: 0, attempt, pid: handle.pid, backend: route.backend };
      recordWorkerPid(ctx.runDir, pidRecord);
      const unbind = bindAbort(interruptOf(ctx), handle);
      let sawUsageEvent = false;
      let harnessError: string | undefined;

      const res = await (async () => {
        try {
          const transcriptMeta = { role: "planner" as const, task_id: null, generation: null, attempt, backend: route.backend, model: route.model };
          for await (const evt of teeTranscript(handle.events, ctx.runDir, transcriptMeta, currentSessionId)) {
            if (evt.type === "session.started" && evt.session_id) {
              currentSessionId = evt.session_id;
            }
            if (evt.type === "error") {
              harnessError = evt.message;
            }
            if (evt.type === "usage" && evt.record) {
              sawUsageEvent = true;
              const { delta, next } = toDelta(sessionTotals, evt.record, Boolean(evt.cumulative));
              sessionTotals = next;
              totalUsd += delta.cost_usd;
              emit("usage.recorded", { record: delta, role: "planner" });
              if (checkRunBudget(ctx, emit, totalUsd)) {
                stoppedForBudget = true;
              }
            }
          }
          return await handle.result();
        } finally {
          unbind();
          clearWorkerPid(ctx.runDir, pidRecord);
        }
      })();
      if (res.session_id) currentSessionId = res.session_id;
      if (!sawUsageEvent && res.usage) {
        totalUsd += res.usage.cost_usd;
        emit("usage.recorded", { record: res.usage, role: "planner" });
        if (checkRunBudget(ctx, emit, totalUsd)) {
          stoppedForBudget = true;
        }
      }

      if (stoppedForBudget) return;
      // An abort ends the run as user_cancel (the engine loop emits it); the
      // killed planner session is not a task or run failure.
      if (interruptOf(ctx)?.aborted) return;

      if (!res.ok || (res.exit_code !== null && res.exit_code !== 0)) {
        const runCapUsd = ctx.settings.budgets?.run?.max_usd;
        if (res.killed_for === "budget" && runCapUsd !== undefined) {
          const capUsd = plannerSpawnBudgetUsd(runCapUsd, totalUsd) ?? runCapUsd;
          emit("task.failed", {
            failure_class: "budget_exceeded",
            message: boundedMessage(
              plannerBudgetMessage(capUsd, sessionTotals?.cost_usd ?? res.usage.cost_usd, runCapUsd),
            ),
          });
          emit("run.finished", { exit_code: 1, status: "failed" });
          return;
        }
        emit("task.failed", {
          failure_class: "worker_crashed",
          message: boundedMessage(sessionFailureMessage(res.exit_code, res.final_text, harnessError, route.backend)),
        });
        emit("run.finished", { exit_code: 1, status: "failed" });
        return;
      }

      const line = finishLine(res.final_text);

      if (line === "NEEDS INPUT") {
        const qPath = path.resolve(ctx.runDir, "QUESTIONS.md");
        if (!fs.existsSync(qPath)) {
          diagnostics = ["finish line NEEDS INPUT requires QUESTIONS.md in the run directory"];
          continue;
        }
        let newQuestions: Question[] = [];
        try {
          newQuestions = parseQuestions(fs.readFileSync(qPath, "utf8"));
        } catch {}
        emit("run.paused", {
          reason: "needs_human",
          questions_path: qPath,
          session_id: currentSessionId,
          questions: newQuestions,
        });
        return;
      }

      if (line !== "PLAN READY") {
        diagnostics = [
          "finish line must be PLAN READY or NEEDS INPUT",
          `got: ${line || "(empty)"}`,
        ];
        continue;
      }

      const qPath = path.resolve(ctx.runDir, "QUESTIONS.md");
      if (fs.existsSync(qPath)) {
        diagnostics = ["QUESTIONS.md is present but the finish line is PLAN READY"];
        continue;
      }

      const ingested = await ingestPlanDraft({ runDir: ctx.runDir, repoRoot: ctx.repoRoot, settings: ctx.settings });
      if (!ingested.ok) {
        diagnostics = ingested.diagnostics;
        continue;
      }
      const { manifest, plan: parsedPlan } = ingested;
      // R12.3: the warnings of the accepted plan are kept in the run directory and carried by plan.produced.
      const warnings = planWarningsOf(ingested.warnings, ctx.runDir, ctx.repoRoot);
      writePlanWarnings(ctx.runDir, warnings);

      const base = resolveBaseRef(ctx.repoRoot, manifest.base_ref);
      const commitSha = await commitContractStubs(
        ctx.repoRoot,
        ctx.runId,
        base.sha,
        manifest.contracts,
        ctx.runDir,
      );

      emit("contracts.committed", { commit_sha: commitSha, ...(base.note ? { note: base.note } : {}) });
      emit("plan.produced", {
        manifest,
        tasks: planTasksForEvent(manifest, parsedPlan.specs),
        commit_sha: commitSha,
        ...(currentSessionId ? { planner_session_id: currentSessionId } : {}),
        ...planWarningsEventData(warnings),
      });
      return;
    }

    emit("plan.format_rejected", formatRejectedData(maxAttempts, maxAttempts, diagnostics));
    emit("task.failed", {
      failure_class: "spec_invalid",
      message: boundedMessage(
        `Planner format retries exhausted after ${maxAttempts} attempts` +
          (diagnostics.length > 0 ? `: ${diagnostics.join("; ")}` : "")
      ),
    });
    emit("run.finished", { exit_code: 1, status: "failed" });
    return;
  }

  // Normal first planning turn
  const plannerEmit: PlannerEmit = <T extends EventType>(
    type: T,
    data: EventData<T>
  ) => {
    const evt = emit(type, data);
    if (type === "usage.recorded") {
      const record = (data as { record?: { cost_usd?: number } })?.record;
      totalUsd += record?.cost_usd ?? 0;
      log.debug(`[DEBUG] plan action: planner usage ${totalUsd.toFixed(2)}`);
      if (checkRunBudget(ctx, emit, totalUsd)) {
        stoppedForBudget = true;
      }
    }
    return evt;
  };

  const historyAll = Boolean(
    (ctx as any).historyAll ||
    (ctx.settings as any).historyAll ||
    (ctx.settings as any).overrides?.historyAll
  );
  const substrateDir = path.join(ctx.repoRoot, ".substrate");
  const charter = plannerCharter(substrateDir);
  const history = plannerHistory(substrateDir, { historyAll });

  let outcome;
  try {
    outcome = await runPlanner({
      runId: ctx.runId,
      repoRoot: ctx.repoRoot,
      runDir: ctx.runDir,
      request: ctx.prompt ?? "",
      settings: ctx.settings,
      adapter,
      route,
      onEvent: plannerEmit,
      charter,
      history,
      signal: interruptOf(ctx),
      runBudgetExceeded: () => stoppedForBudget,
      runSpentUsd: () => totalUsd,
    });
  } catch (err) {
    if (stoppedForBudget) return;
    if (interruptOf(ctx)?.aborted) return;

    if (err instanceof PlannerFailure) {
      const failureClass =
        err.reason === "budget" ? "budget_exceeded" : err.reason === "session" ? "worker_crashed" : "spec_invalid";
      emit("task.failed", { failure_class: failureClass, message: plannerFailureMessage(err) });
      emit("run.finished", { exit_code: 1, status: "failed" });
      return;
    }
    // The first planner never started (R13.1): a planning failure that names the binary, not an internal error.
    if (err instanceof HarnessSpawnError) {
      emit("task.failed", { failure_class: "worker_crashed", message: boundedMessage(`the planner could not start: ${err.message}`) });
      emit("run.finished", { exit_code: 1, status: "failed" });
      return;
    }
    throw err;
  }

  if (stoppedForBudget) return;
  // R11.2: a planner stopped by the run's time limit has no plan to record; the run is already paused.
  if (interruptOf(ctx)?.aborted) return;

  if (outcome.kind === "needs_input") {
    let questions: Question[] = [];
    if (fs.existsSync(outcome.questionsPath)) {
      try {
        const content = fs.readFileSync(outcome.questionsPath, "utf8");
        questions = parseQuestions(content);
      } catch {}
    }
    emit("run.paused", {
      reason: "needs_human",
      questions_path: outcome.questionsPath,
      session_id: outcome.sessionId,
      questions,
    });
    return;
  }

  emit("contracts.committed", {
    commit_sha: outcome.commitSha,
    ...(outcome.baseNote ? { note: outcome.baseNote } : {}),
  });
  emit("plan.produced", {
    manifest: outcome.plan.manifest,
    tasks: planTasksForEvent(outcome.plan.manifest, outcome.plan.specs),
    commit_sha: outcome.commitSha,
    ...(outcome.sessionId ? { planner_session_id: outcome.sessionId } : {}),
    ...planWarningsEventData(outcome.warnings),
  });
}
