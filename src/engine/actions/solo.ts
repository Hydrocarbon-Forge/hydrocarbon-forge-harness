import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import type { SpawnRequest } from "../../contracts/index.js";
import { assembleSystem } from "../../prompts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget } from "../effects.js";
import type { UsageTotals } from "../../ledger/usage.js";
import { toDelta } from "../../ledger/usage.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { bindAbort, adapterFor } from "./shared.js";

export async function runSoloTask(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const worker = ctx.settings.roles.worker!;
  const workerBackend = worker.backend;
  const workerModel = worker.model;

  const adapter = adapterFor(ctx, workerBackend);
  if (!adapter) {
    emit("run.paused", { reason: "backend_unavailable" });
    return;
  }

  const sessionId = crypto.randomUUID();
  emit("task.session.started", {
    task_id: "solo",
    generation: 1,
    attempt: 1,
    session_id: sessionId,
  });

  const spawnReq: SpawnRequest = {
    role: "worker",
    cwd: ctx.repoRoot,
    prompt: ctx.prompt ?? "Execute solo task",
    system_append: assembleSystem("worker", { projectRoot: ctx.repoRoot }),
    raw_dir: ctx.runDir,
    model: workerModel,
    session: { id: sessionId },
    permission: {
      allow: [ctx.repoRoot],
      deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
    },
    budget: {
      max_usd: ctx.settings.budgets?.task?.max_usd ?? 5.0,
      timeout_ms: 1800000,
    },
  };

  const handle = adapter.spawn(spawnReq);
  const unbind = bindAbort(ctx, handle);
  let res: any;
  // Cumulative usage conversion per session (R1.4).
  const prevUsageTotals = new Map<string, UsageTotals>();
  let localTotal = state.usage.total_usd;
  let sawUsageEvents = false;
  try {
    for await (const evt of handle.events) {
      if (evt.type === "usage" && (evt as any).record) {
        sawUsageEvents = true;
        const { delta, next } = toDelta(
          prevUsageTotals.get(sessionId),
          (evt as any).record,
          Boolean((evt as any).cumulative)
        );
        prevUsageTotals.set(sessionId, next);
        emit("usage.recorded", {
          record: delta,
          role: "worker",
          task_id: "solo",
          generation: 1,
          attempt: 1,
        });
        localTotal = localTotal + (delta.cost_usd ?? 0);
        if (checkRunBudget(ctx, emit, localTotal)) {
          await handle.kill("budget");
          return;
        }
      }
    }
    res = await handle.result();
  } finally {
    unbind();
  }

  // Session-result usage for adapters that never stream usage reports.
  if (!sawUsageEvents && res?.usage) {
    emit("usage.recorded", {
      record: res.usage,
      role: "worker",
      task_id: "solo",
      generation: 1,
      attempt: 1,
    });
    localTotal = localTotal + (res.usage.cost_usd ?? 0);
    if (checkRunBudget(ctx, emit, localTotal)) {
      return;
    }
  }

  if (ctx.signal?.aborted || res?.killed_for === "cancel") {
    return;
  }
  execFileSync("git", ["add", "-A"], { cwd: ctx.repoRoot });
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: ctx.repoRoot,
    encoding: "utf8",
  });
  if (status.trim().length > 0) {
    execFileSync("git", ["commit", "-m", "feat(solo): implement task"], {
      cwd: ctx.repoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "substrate-engine",
        GIT_AUTHOR_EMAIL: "substrate-engine@local",
        GIT_COMMITTER_NAME: "substrate-engine",
        GIT_COMMITTER_EMAIL: "substrate-engine@local",
      },
    });
  }

  emit("task.passed", { task_id: "solo" });
  emit("task.merged", { task_id: "solo" });
  emit("integration.finished", { passed: true });
  emit("run.finished", { exit_code: 0 });
}
