import fs from "node:fs";
import path from "node:path";

import type { EventData, EventType } from "../../contracts/events.js";
import type { Question, SpawnRequest, TaskId } from "../../contracts/index.js";
import {
  PlannerFailure,
  commitContractStubs,
  finishLine,
  runPlanner,
  type PlannerEmit,
} from "../../roles/planner.js";
import { resolvePlannerRoute } from "../../roles/router.js";
import {
  lintPlan,
  parseManifest,
  parseTaskSpec,
  typecheckContracts,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../../spec/index.js";
import { toDelta, type UsageTotals } from "../../ledger/usage.js";
import { loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";
import { buildCorrectionPrompt } from "../../roles/prompts/planner.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { adapterFor } from "./shared.js";
import { bindAbort } from "../../backends/process.js";
import { runLintAction } from "./approve.js";
import { log } from "../../util/log.js";
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
          max_usd: ctx.settings.budgets?.task?.max_usd ?? 5.0,
          timeout_ms: (ctx.settings.budgets?.task?.timeout_min ?? 30) * 60 * 1000,
          ...(ctx.settings.budgets?.task?.max_tokens ? { max_tokens: ctx.settings.budgets.task.max_tokens } : {}),
          ...(ctx.settings.budgets?.task?.timeout_min ? { timeout_min: ctx.settings.budgets.task.timeout_min } : {}),
        },
        session: { resume: currentSessionId },
      };

      const handle = adapter.spawn(spawnReq);
      const unbind = bindAbort(ctx.signal, handle);
      let sawUsageEvent = false;

      const res = await (async () => {
        try {
          for await (const evt of handle.events) {
            if (evt.type === "session.started" && evt.session_id) {
              currentSessionId = evt.session_id;
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
      if (ctx.signal?.aborted) return;

      if (!res.ok || (res.exit_code !== null && res.exit_code !== 0)) {
        emit("task.failed", { failure_class: "worker_crashed" });
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

      const manifestPath = path.resolve(ctx.runDir, "manifest.yaml");
      if (!fs.existsSync(manifestPath)) {
        diagnostics = ["manifest.yaml is missing from the run directory"];
        continue;
      }

      let rawManifest = "";
      try {
        rawManifest = fs.readFileSync(manifestPath, "utf8");
      } catch (err: any) {
        diagnostics = [`Failed to read manifest.yaml: ${err.message}`];
        continue;
      }

      let manifest: any;
      try {
        manifest = parseManifest(rawManifest, manifestPath);
      } catch (err: any) {
        diagnostics = [`Failed to parse manifest.yaml: ${err.message}`];
        continue;
      }

      const specs = new Map<TaskId, ParsedTaskSpec>();
      let specErrors = false;
      for (const task of manifest.tasks) {
        const specPath = path.resolve(ctx.runDir, task.spec);
        if (!fs.existsSync(specPath)) {
          diagnostics = [`Spec file for task ${task.id} does not exist: ${task.spec}`];
          specErrors = true;
          break;
        }
        const rawSpec = fs.readFileSync(specPath, "utf8");
        specs.set(task.id, parseTaskSpec(rawSpec, task.spec));
      }
      if (specErrors) continue;

      const parsedPlan: ParsedPlan = { manifest, specs, rawManifest, manifestPath };
      const lintResult = await lintPlan(parsedPlan, ctx.repoRoot, ctx.settings);
      const errors = lintResult.diagnostics.filter(
        (d) => d.severity === "error" && !isSuppressedForRunDir(ctx.runDir, d)
      );
      if (errors.length > 0) {
        diagnostics = errors.map((d: any) => `[${d.code}] ${d.message}`);
        continue;
      }

      let typecheckRes: any;
      try {
        typecheckRes = await typecheckContracts(ctx.runDir, manifest.contracts, {
          cwd: ctx.runDir,
        });
      } catch (err: any) {
        typecheckRes = {
          ok: false,
          diagnostics: [{ code: "L018", severity: "error", message: err.message }],
        };
      }
      const typecheckErrors = (typecheckRes.diagnostics ?? []).filter((d: any) => d.severity === "error");
      if (!typecheckRes.ok || typecheckErrors.length > 0) {
        diagnostics = typecheckErrors.length > 0
          ? typecheckErrors.map((d: any) => `[${d.code}] ${d.message}`)
          : ["Contract typecheck failed with a non-zero exit code"];
        continue;
      }

      const commitSha = await commitContractStubs(
        ctx.repoRoot,
        ctx.runId,
        manifest.base_ref ?? "HEAD",
        manifest.contracts,
        ctx.runDir,
      );

      emit("contracts.committed", { commit_sha: commitSha });
      emit("plan.produced", {
        manifest,
        tasks: manifest.tasks,
        commit_sha: commitSha,
      });
      return;
    }

    emit("task.failed", { failure_class: "spec_invalid" });
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
      signal: ctx.signal,
    });
  } catch (err) {
    if (stoppedForBudget) return;
    if (ctx.signal?.aborted) return;

    if (err instanceof PlannerFailure) {
      const failureClass = err.reason === "session" ? "worker_crashed" : "spec_invalid";
      emit("task.failed", { failure_class: failureClass });
      emit("run.finished", { exit_code: 1, status: "failed" });
      return;
    }
    throw err;
  }

  if (stoppedForBudget) return;

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

  emit("contracts.committed", { commit_sha: outcome.commitSha });
  emit("plan.produced", {
    manifest: outcome.plan.manifest,
    tasks: outcome.plan.manifest.tasks,
    commit_sha: outcome.commitSha,
  });
}
