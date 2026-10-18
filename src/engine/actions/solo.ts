import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import type { SpawnRequest } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { bindAbort } from "./shared.js";

export async function runSoloTask(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const workerModel =
    (ctx.settings.roles as any)?.worker?.model ?? "claude-haiku-5-5";
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

  const handle = ctx.adapter.spawn(spawnReq);
  const unbind = bindAbort(ctx, handle);
  let res: any;
  try {
    for await (const evt of handle.events) {
      if (evt.type === "usage" && (evt as any).record) {
        emit("usage.recorded", {
          record: (evt as any).record,
          role: "worker",
          task_id: "solo",
          generation: 1,
          attempt: 1,
        });
      }
    }
    res = await handle.result();
  } finally {
    unbind();
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
