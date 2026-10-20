import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { BackendEvent, Command, WorkerReport } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { adapterFor } from "./shared.js";
import { resolveTaskRoute } from "../../roles/router.js";
import { getRunBranch, workspaceManager } from "../../git/index.js";
import {
  runWorker,
  type TaskTotals,
  type WorkerObservation,
  type WorkerRunPolicy,
  type WorkerStopDecision,
} from "../../roles/worker.js";
import { detectEcosystem, getDefaultVerify } from "../../spec/ecosystem.js";

const BACKOFF_MS = [1000, 2000, 4000];

function isRateLimit(event: BackendEvent | undefined): boolean {
  return event?.type === "error" && event.kind === "rate_limit";
}

function writeAttemptReport(ctx: EffectContext, report: WorkerReport): void {
  const packetsDir = path.join(ctx.runDir, "packets");
  fs.mkdirSync(packetsDir, { recursive: true });
  const name = `${report.task_id}-g${report.generation}-attempt${report.attempt}.json`;
  fs.writeFileSync(path.join(packetsDir, name), JSON.stringify(report, null, 2), "utf8");
}

export async function runSoloTask(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const verifyFlags: string[] | undefined =
    (ctx.settings as any).verify ?? (ctx as any).verify;

  let verifyList: Command[] = [];
  if (verifyFlags && verifyFlags.length > 0) {
    verifyList = verifyFlags.map((cmd) => ({ run: cmd, timeout_s: 300 }));
  } else {
    const eco = await detectEcosystem(ctx.repoRoot);
    verifyList = getDefaultVerify(eco);
  }

  const soloSpec = {
    id: "SOLO",
    class: "feature" as const,
    title: "solo task",
    write: ["**"],
    create: [],
    read: [],
    protected: [],
    verify: verifyList,
    budget: {
      max_usd: ctx.settings.budgets?.task?.max_usd,
      max_tokens: ctx.settings.budgets?.task?.max_tokens,
      timeout_min: ctx.settings.budgets?.task?.timeout_min,
      max_turns: ctx.settings.budgets?.task?.max_turns,
    },
  };

  const taskState = state.tasks["SOLO"] ?? {
    id: "SOLO",
    state: "READY",
    generation: 1,
    attempt: 1,
  };

  const generation = taskState.generation ?? 1;
  const isHeal = action.type === "heal" || taskState.state === "HEALING";
  const attempt = isHeal ? 2 : (taskState.attempt ?? 1);
  const sessionId = taskState.session_id ?? crypto.randomUUID();

  const existingWorktree = path.join(
    ctx.repoRoot,
    ".substrate",
    "worktrees",
    ctx.runId,
    `SOLO-g${generation}`
  );
  const resumeExistingSession =
    taskState.session_id !== undefined && fs.existsSync(existingWorktree);

  let route = resolveTaskRoute("feature", generation, ctx.settings);
  if (ctx.settings.roles?.worker) {
    route = {
      ...route,
      backend: ctx.settings.roles.worker.backend ?? route.backend,
      model: ctx.settings.roles.worker.model ?? route.model,
      ...(ctx.settings.roles.worker.effort !== undefined
        ? { effort: ctx.settings.roles.worker.effort }
        : {}),
    };
  }
  const adapter = adapterFor(ctx, route.backend);
  if (!adapter) {
    emit("run.paused", { reason: "backend_unavailable" });
    return;
  }

  let localTotal = state.usage.total_usd;
  let localTokens = 0;
  let rateLimits = 0;

  const taskBudget = {
    max_usd: soloSpec.budget.max_usd ?? ctx.settings.budgets.task.max_usd,
    max_tokens: soloSpec.budget.max_tokens ?? ctx.settings.budgets.task.max_tokens,
    max_turns: soloSpec.budget.max_turns ?? ctx.settings.budgets.task.max_turns,
  };

  const rateLimitDecision = (): WorkerStopDecision => {
    rateLimits += 1;
    const effective = ctx.concurrency;
    const halved = Math.max(1, Math.floor(effective / 2));

    if (rateLimits >= 4 || halved === effective) {
      ctx.concurrency = halved;
      emit("rate_limit.backoff", { task_id: "SOLO", concurrency: ctx.concurrency });
      emit("run.paused", { reason: "rate_limited" });
      return {
        stop: true,
        kill: "cancel",
        failure_class: "rate_limited",
        detail:
          rateLimits >= 4
            ? "four rate limits for this task"
            : "concurrency already at the floor",
      };
    }

    ctx.concurrency = halved;
    emit("rate_limit.backoff", { task_id: "SOLO", concurrency: ctx.concurrency });
    return { stop: true, kill: "cancel", backoff_ms: BACKOFF_MS[rateLimits - 1] };
  };

  const taskBudgetDecision = (totals: TaskTotals): WorkerStopDecision | undefined => {
    const crossed = (limit: number | undefined, value: number, label: string) =>
      limit !== undefined && value >= limit ? label : undefined;

    const which =
      crossed(taskBudget.max_usd, totals.cost_usd, "cost") ??
      crossed(taskBudget.max_tokens, totals.tokens, "tokens") ??
      crossed(taskBudget.max_turns, totals.turns, "turns");

    if (!which) return undefined;
    return {
      stop: true,
      kill: "budget",
      failure_class: "budget_exceeded",
      detail: `task ${which} budget`,
    };
  };

  const runPolicy: WorkerRunPolicy = (obs: WorkerObservation) => {
    const delta = obs.usageDelta;
    const contributed =
      (delta?.cost_usd ?? 0) + (delta?.input_tokens ?? 0) + (delta?.output_tokens ?? 0);

    if (delta && contributed > 0) {
      localTotal += delta.cost_usd ?? 0;
      localTokens += (delta.input_tokens ?? 0) + (delta.output_tokens ?? 0);
    }

    if (checkRunBudget(ctx, emit, localTotal, localTokens)) {
      return { stop: true, kill: "budget" };
    }

    if (obs.totals && (contributed > 0 || obs.totals.turns > 0)) {
      const decision = taskBudgetDecision(obs.totals);
      if (decision) return decision;
    }

    if (obs.event?.type === "permission.denied") {
      emit("run.paused", { reason: "permission_denied" });
      return { stop: true, kill: "cancel" };
    }

    if (isRateLimit(obs.event)) {
      return rateLimitDecision();
    }

    const res = obs.result;
    if (res) {
      if (ctx.signal?.aborted || res.killed_for === "cancel") {
        return { stop: true };
      }
      if (res.killed_for === "budget") {
        emit("run.budget.exceeded", {});
        emit("run.paused", { reason: "budget_exhausted" });
        return { stop: true };
      }
      if (res.denials && res.denials.length > 0) {
        emit("run.paused", { reason: "permission_denied" });
        return { stop: true };
      }
    }

    return { stop: false };
  };

  const goalText = ctx.prompt ?? "Execute solo task";

  const settingsForWorker = {
    ...ctx.settings,
    routing: {
      ...ctx.settings.routing,
      feature: route,
    },
  };

  await runWorker({
    runId: ctx.runId,
    taskId: "SOLO",
    spec: soloSpec as any,
    specContent: goalText,
    specAbsPath: path.join(ctx.runDir, "tasks", "SOLO.md"),
    generation,
    repoRoot: ctx.repoRoot,
    settings: settingsForWorker as any,
    adapter,
    baseRef: getRunBranch(ctx.runId),
    rawDir: ctx.runDir,
    setupCommands: [],
    attempt,
    session:
      isHeal || resumeExistingSession
        ? { resume: taskState.session_id ?? sessionId }
        : { id: sessionId },
    signal: ctx.signal,
    runPolicy,
    onEvent: emit,
    onReport: (report) => writeAttemptReport(ctx, report),
  });
}
