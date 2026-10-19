import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { BackendEvent, Manifest, UsageRecord } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { safeParseManifest, adapterFor } from "./shared.js";
import { runSoloTask } from "./solo.js";
import { parseTaskSpec } from "../../spec/index.js";
import { resolveTaskRoute } from "../../roles/router.js";
import { getRunBranch } from "../../git/index.js";
import { runWorker, type WorkerObservation, type WorkerRunPolicy } from "../../roles/worker.js";

function isRateLimit(event: BackendEvent | undefined): boolean {
  return (
    event?.type === "error" &&
    ((event as any).kind === "rate_limit" ||
      String((event as any).message).includes("Rate limit"))
  );
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

      if (isHeal) {
        emit("task.healing", {
          task_id: taskId,
          generation,
          attempt: 2,
          ...(taskState.session_id ? { session_id: taskState.session_id } : {}),
        });
      }

      const route = resolveTaskRoute(parsedSpec.frontmatter.class, generation, ctx.settings);

      const adapter = adapterFor(ctx, route.backend);
      if (!adapter) {
        emit("run.paused", { reason: "backend_unavailable" });
        return;
      }

      // Run-level policy is decided here, not by the role (R1.4, R1.5). The worker
      // reports what it observed and this answers whether the attempt must stop.
      let localTotal = state.usage.total_usd;

      const rateLimitDecision = () => {
        const currentConcurrency = ctx.settings.concurrency?.workers ?? 1;
        if (currentConcurrency <= 1) {
          emit("run.paused", { reason: "rate_limited" });
          return { stop: true };
        }
        ctx.settings.concurrency.workers = Math.max(1, Math.floor(currentConcurrency / 2));
        emit("rate_limit.backoff", {
          task_id: taskId,
          concurrency: ctx.settings.concurrency.workers,
        });
        emit("task.ready", { task_id: taskId });
        return { stop: true };
      };

      const runPolicy: WorkerRunPolicy = (obs: WorkerObservation) => {
        if (obs.usageDelta) {
          localTotal += obs.usageDelta.cost_usd ?? 0;
          if (checkRunBudget(ctx, emit, localTotal)) {
            return { stop: true, kill: "budget" };
          }
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
          if (res.final_text?.includes("Rate limit")) {
            return rateLimitDecision();
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
      });

      return;
    }
  }
}
