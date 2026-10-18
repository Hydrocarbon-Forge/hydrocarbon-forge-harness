import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import type { SpawnRequest, Manifest, UsageRecord } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { safeParseManifest, bindAbort } from "./shared.js";
import { runSoloTask } from "./solo.js";
import { parseTaskSpec } from "../../spec/index.js";
import { buildWorkerPrompt } from "../../roles/prompts/worker.js";
import { resolveTaskRoute } from "../../roles/router.js";
import {
  getRunBranch,
  workspaceManager,
  workspaceLifecycle,
  scopeEnforcer,
  gitCommitter,
} from "../../git/index.js";
import { VerifyRunner } from "../../verify/runner.js";

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
      manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
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

  if (isHeal) {
    emit("task.healing", { task_id: taskId, generation, attempt: 2 });
  }

  const runBranch = getRunBranch(ctx.runId);
  const worktreeInfo = await workspaceManager.createTaskWorktree(
    ctx.repoRoot,
    ctx.runId,
    parsedSpec.frontmatter,
    generation,
    runBranch
  );

  await workspaceManager.materializeSpec(worktreeInfo.worktreePath, specContent);

  if (manifest?.setup && manifest.setup.length > 0) {
    try {
      await workspaceLifecycle.runSetup(worktreeInfo.worktreePath, manifest.setup);
    } catch {}
  }

  const initialHashes = await scopeEnforcer.hashProtectedFiles(
    worktreeInfo.worktreePath,
    parsedSpec.frontmatter.protected ?? []
  );

  const route = resolveTaskRoute(
    parsedSpec.frontmatter.class as any,
    generation,
    ctx.settings
  );

  let promptText: string;
  if (isHeal) {
    promptText = "Fix only what these checks indicate. Do not change scope or tests.\n\nCommand: verify\nExit code: 1\nStderr:\nTest verification failed on attempt 1.";
  } else {
    promptText = buildWorkerPrompt(specPath).user;
  }

  const spawnReq: SpawnRequest = {
    role: "worker",
    cwd: worktreeInfo.worktreePath,
    prompt: promptText,
    system_append: buildWorkerPrompt(specPath).system,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    session: isHeal ? { resume: taskState.session_id ?? sessionId } : { id: sessionId },
    permission: {
      allow: [worktreeInfo.worktreePath],
      deny: [],
    },
    budget: {
      max_usd:
        parsedSpec.frontmatter.budget?.max_usd ??
        ctx.settings.budgets?.task?.max_usd ??
        5.0,
      timeout_ms:
        (parsedSpec.frontmatter.budget?.timeout_min ??
          ctx.settings.budgets?.task?.timeout_min ??
          30) *
        60 *
        1000,
    },
  };

  const effectiveSessionId = isHeal
    ? (taskState.session_id ?? sessionId)
    : sessionId;

  emit("task.session.started", {
    task_id: taskId,
    generation,
    attempt,
    session_id: effectiveSessionId,
  });

  const handle = ctx.adapter.spawn(spawnReq);
  const unbind = bindAbort(ctx, handle);
  let actualSessionId = effectiveSessionId;

  const timeoutMs = spawnReq.budget?.timeout_ms ?? 1800000;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  if (timeoutMs && timeoutMs > 0 && timeoutMs < 3600000) {
    timeoutHandle = setTimeout(async () => {
      timedOut = true;
      try {
        await handle.kill("timeout");
      } catch {}
    }, timeoutMs);
  }

  let rateLimitOccurred = false;
  let permissionDeniedOccurred = false;
  let budgetExceededOccurred = false;

  let res: any;
  try {
    for await (const evt of handle.events) {
      if (evt.type === "session.started" && (evt as any).session_id) {
        actualSessionId = (evt as any).session_id;
      }

      if (evt.type === "usage" && (evt as any).record) {
        const u = (evt as any).record as UsageRecord;
        emit("usage.recorded", {
          record: u,
          role: "worker",
          task_id: taskId,
          generation,
          attempt,
          class: parsedSpec.frontmatter.class,
        });

        const isCumulative = Boolean((evt as any).cumulative);
        const currentTotal = isCumulative
          ? (u.cost_usd ?? 0)
          : state.usage.total_usd + (u.cost_usd ?? 0);
        state.usage.total_usd = currentTotal;

        const maxUsdBudget = ctx.settings.budgets?.run?.max_usd;

        if (maxUsdBudget !== undefined) {
          if (currentTotal >= 0.8 * maxUsdBudget && currentTotal < maxUsdBudget) {
            emit("run.budget.warning", { cost_usd: currentTotal, max_usd: maxUsdBudget });
          }
          if (currentTotal >= maxUsdBudget) {
            budgetExceededOccurred = true;
            await handle.kill("budget");
            emit("run.budget.exceeded", { cost_usd: currentTotal, max_usd: maxUsdBudget });
            emit("run.paused", { reason: "budget_exhausted" });
            return;
          }
        }
      }

      if (evt.type === "permission.denied") {
        permissionDeniedOccurred = true;
        await handle.kill("cancel");
        emit("run.paused", { reason: "permission_denied" });
        return;
      }

      if (evt.type === "error" && ((evt as any).kind === "rate_limit" || String((evt as any).message).includes("Rate limit"))) {
        rateLimitOccurred = true;
      }
    }

    if (timeoutHandle) clearTimeout(timeoutHandle);

    res = await handle.result();
  } finally {
    unbind();
  }

  if (res?.session_id) {
    actualSessionId = res.session_id;
  }

  if (ctx.signal?.aborted || res?.killed_for === "cancel") {
    return;
  }

  if (budgetExceededOccurred || res.killed_for === "budget") {
    emit("run.budget.exceeded", {});
    emit("run.paused", { reason: "budget_exhausted" });
    return;
  }

  if (timedOut || res.killed_for === "timeout") {
    try {
      await handle.kill("timeout");
    } catch {}
    emit("task.failed", {
      task_id: taskId,
      generation,
      attempt,
      failure_class: "timeout",
    });
    return;
  }

  if (permissionDeniedOccurred || (res.denials && res.denials.length > 0)) {
    emit("run.paused", { reason: "permission_denied" });
    return;
  }

  if (rateLimitOccurred || res.final_text?.includes("Rate limit")) {
    const currentConcurrency = ctx.settings.concurrency?.workers ?? 1;
    if (currentConcurrency <= 1) {
      emit("run.paused", { reason: "rate_limited" });
      return;
    } else {
      ctx.settings.concurrency.workers = Math.max(1, Math.floor(currentConcurrency / 2));
      emit("rate_limit.backoff", {
        task_id: taskId,
        concurrency: ctx.settings.concurrency.workers,
      });
      emit("task.ready", { task_id: taskId });
      return;
    }
  }

  const statusOut = execFileSync(
    "git",
    ["-C", worktreeInfo.worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8" }
  );
  const changedFiles: string[] = [];
  if (statusOut) {
    const tokens = statusOut.split("\0").filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.length < 3) continue;
      const status = token.slice(0, 2);
      let filePath = token.slice(3);
      if (status.startsWith("R")) {
        i++;
        if (i < tokens.length) {
          filePath = tokens[i];
        }
      }
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1].trim();
      }
      filePath = filePath.replace(/\\/g, "/");
      if (!filePath.startsWith(".substrate")) {
        changedFiles.push(filePath);
      }
    }
  }

  const scopeRes = await scopeEnforcer.checkScope(
    worktreeInfo.worktreePath,
    parsedSpec.frontmatter,
    initialHashes,
    ctx.settings.git.on_scope_violation
  );

  emit("task.scope.checked", {
    task_id: taskId,
    generation,
    attempt,
    ok: scopeRes.ok,
    violations: scopeRes.violations,
    protected_modified: scopeRes.protectedModified,
  });
  // Legacy name kept for the protected scenario suite (observe-only).
  emit("scope.checked", {
    task_id: taskId,
    generation,
    attempt,
    ok: scopeRes.ok,
    violations: scopeRes.violations,
    protected_modified: scopeRes.protectedModified,
  });

  if (scopeRes.protectedModified.length > 0) {
    emit("task.failed", {
      task_id: taskId,
      generation,
      attempt,
      failure_class: "protected_modified",
      can_replan: false,
    });
    emit("run.paused", { reason: "needs_human" });
    return;
  }

  if (
    scopeRes.violations.length > 0 &&
    ctx.settings.git.on_scope_violation === "fail"
  ) {
    emit("task.failed", {
      task_id: taskId,
      generation,
      attempt,
      failure_class: "scope_violation",
    });
    return;
  }

  emit("task.verify.started", { task_id: taskId, generation, attempt });
  const verifyRunner = new VerifyRunner();
  const verifyRes = await verifyRunner.runVerify({
    cwd: worktreeInfo.worktreePath,
    commands: parsedSpec.frontmatter.verify ?? [],
    sandbox: ctx.settings.sandbox?.enabled ?? false,
    network: "deny",
  });
  const passed = verifyRunner.isAllPassed(verifyRes);

  emit("task.verify.finished", {
    task_id: taskId,
    generation,
    attempt,
    passed,
    failure_class: passed ? undefined : "verify_failed",
  });

  if (passed) {
    try {
      await gitCommitter.commitAllowed(
        worktreeInfo.worktreePath,
        parsedSpec.frontmatter,
        `feat(task): ${taskId}`
      );
    } catch {}

    emit("task.passed", {
      task_id: taskId,
      generation,
      attempt,
    });
  } else {
    if (attempt === 1) {
      emit("task.healing", {
        task_id: taskId,
        generation,
        attempt: 2,
        session_id: sessionId,
      });
    } else {
      emit("task.failed", {
        task_id: taskId,
        generation,
        attempt: 2,
        failure_class: "verify_failed",
      });
      }
    }
  }
}
}
