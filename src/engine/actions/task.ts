import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { BackendEvent, Manifest, UsageRecord, WorkerReport } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { safeParseManifest, adapterFor } from "./shared.js";
import { runSoloTask } from "./solo.js";
import { parseTaskSpec } from "../../spec/index.js";
import { resolveTaskRoute } from "../../roles/router.js";
import { getRunBranch } from "../../git/index.js";
import {
  runWorker,
  type TaskTotals,
  type WorkerObservation,
  type WorkerRunPolicy,
  type WorkerStopDecision,
} from "../../roles/worker.js";

/** Rate limit backoff delays for the first three limits of a task (R3.4). */
const BACKOFF_MS = [1000, 2000, 4000];

function isRateLimit(event: BackendEvent | undefined): boolean {
  // Typed events only: the rate limit is the error kind, never a message match (R3.4).
  return event?.type === "error" && event.kind === "rate_limit";
}

export async function runTaskAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  switch (action.type) {
    case "worker":
    case "heal": {
      const taskId = action.taskId ?? "solo";

      if (taskId === "solo") {
        await runSoloTask(action, ctx, state, emit);
        return;
      }

      const manifestPath = path.join(ctx.runDir, "manifest.yaml");
      let manifest: Manifest | undefined;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = safeParseManifest(
            fs.readFileSync(manifestPath, "utf8"),
            manifestPath
          );
        } catch {}
      }

      const specRel = manifest?.tasks.find((t) => t.id === taskId)?.spec ?? `tasks/${taskId}.md`;
      const specPath = path.resolve(ctx.runDir, specRel);
      let specContent = "";
      if (fs.existsSync(specPath)) {
        specContent = fs.readFileSync(specPath, "utf8");
      }
      const parsedSpec = parseTaskSpec(specContent, specPath);

      const taskState = state.tasks[taskId] ?? {
        id: taskId,
        state: "READY",
        generation: 1,
        attempt: 1,
      };

      const generation = taskState.generation ?? 1;
      const isHeal = action.type === "heal" || taskState.state === "HEALING";
      const attempt = isHeal ? 2 : (taskState.attempt ?? 1);
      const sessionId = taskState.session_id ?? crypto.randomUUID();

      // A task put back in the queue by `resume` keeps its session when the worktree
      // that session worked in is still present; otherwise a new session is started.
      const existingWorktree = path.join(
        ctx.repoRoot,
        ".substrate",
        "worktrees",
        ctx.runId,
        `${taskId}-g${generation}`
      );
      const resumeExistingSession =
        taskState.session_id !== undefined && fs.existsSync(existingWorktree);

      // The heal event is the worker's, because the role is what has the failing
      // VerifyResults to render into it (R3.4).
      const route = resolveTaskRoute(parsedSpec.frontmatter.class, generation, ctx.settings);

      const adapter = adapterFor(ctx, route.backend);
      if (!adapter) {
        emit("run.paused", { reason: "backend_unavailable" });
        return;
      }

      // Run-level policy is decided here, not by the role (R1.4, R1.5). The worker
      // reports what it observed and this answers whether the attempt must stop.
      let localTotal = state.usage.total_usd;
      // The reducer accumulates cost only, so the run token total is what this action
      // has seen for the run.
      let localTokens = 0;
      let rateLimits = 0;

      const taskBudget = {
        max_usd: parsedSpec.frontmatter.budget?.max_usd ?? ctx.settings.budgets.task.max_usd,
        max_tokens:
          parsedSpec.frontmatter.budget?.max_tokens ?? ctx.settings.budgets.task.max_tokens,
        max_turns:
          parsedSpec.frontmatter.budget?.max_turns ?? ctx.settings.budgets.task.max_turns,
      };

      const rateLimitDecision = (): WorkerStopDecision => {
        rateLimits += 1;
        const effective = ctx.concurrency;
        const halved = Math.max(1, Math.floor(effective / 2));

        // The fourth rate limit for this task ends it; and at the floor there is
        // nothing left to halve, which is the L3 pause rule (R3.4). The settings value
        // itself is never mutated: the halving lives on the run's EffectContext.
        if (rateLimits >= 4 || halved === effective) {
          ctx.concurrency = halved;
          emit("rate_limit.backoff", { task_id: taskId, concurrency: ctx.concurrency });
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
        emit("rate_limit.backoff", { task_id: taskId, concurrency: ctx.concurrency });
        return { stop: true, kill: "cancel", backoff_ms: BACKOFF_MS[rateLimits - 1] };
      };

      const taskBudgetDecision = (totals: TaskTotals): WorkerStopDecision | undefined => {
        const crossed = (limit: number | undefined, value: number, label: string) =>
          limit !== undefined && value >= limit ? label : undefined;

        const which =
          crossed(taskBudget.max_usd, totals.cost_usd, "cost") ??
          crossed(taskBudget.max_tokens, totals.tokens, "tokens") ??
          crossed(taskBudget.max_turns, totals.turns, "turns");

        // A per-task budget ends only the task; it never pauses the run (R3.4).
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

        // A discarded usage record (a duplicate cumulative event) is not checked.
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

      await runWorker({
        runId: ctx.runId,
        taskId,
        spec: parsedSpec.frontmatter,
        specContent,
        specAbsPath: specPath,
        generation,
        repoRoot: ctx.repoRoot,
        settings: ctx.settings,
        adapter,
        baseRef: getRunBranch(ctx.runId),
        rawDir: ctx.runDir,
        setupCommands: manifest?.setup ?? [],
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

      // R3.5 rule 2: each attempt is recorded as it finishes, so the failure packet for
      // the next generation is built from the files, not from memory. `onReport` above
      // records every attempt, including the one returned here.

      return;
    }
  }
}

function writeAttemptReport(ctx: EffectContext, report: WorkerReport): void {
  const packetsDir = path.join(ctx.runDir, "packets");
  fs.mkdirSync(packetsDir, { recursive: true });
  const name = `${report.task_id}-g${report.generation}-attempt${report.attempt}.json`;
  fs.writeFileSync(path.join(packetsDir, name), JSON.stringify(report, null, 2), "utf8");
}
