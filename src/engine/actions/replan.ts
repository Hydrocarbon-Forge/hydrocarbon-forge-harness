import fs from "node:fs";
import path from "node:path";

import type {
  FailureClass,
  FailurePacket,
  Manifest,
  RunId,
  SpawnRequest,
} from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { checkRunBudget } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { UsageTotals } from "../../ledger/usage.js";
import { toDelta } from "../../ledger/usage.js";
import type { Emit } from "./shared.js";
import { safeParseManifest, bindAbort } from "./shared.js";
import { evaluateEscalation } from "../ladder.js";
import { buildFailurePacket } from "../packet.js";
import { getRunBranch, workspaceLifecycle } from "../../git/index.js";
import { buildReplanPrompt } from "../../roles/prompts/replan.js";
import { commitContractStubs } from "../../roles/planner.js";

export async function runReplanAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const taskId = action.taskId;
  if (!taskId) return;

  const taskState = state.tasks[taskId] ?? {
    id: taskId,
    state: "FAILED",
    generation: 1,
    attempt: 2,
  };

  const failureClass: FailureClass = taskState.failure_class ?? "verify_failed";
  const escalation = evaluateEscalation(state, taskId, failureClass, ctx.settings);

  if (escalation.level === "L1") {
    const packetsDir = path.join(ctx.runDir, "packets");
    fs.mkdirSync(packetsDir, { recursive: true });

    const manifestPath = path.join(ctx.runDir, "manifest.yaml");
    let manifest: Manifest | undefined;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
      } catch {}
    }
    const specRel = manifest?.tasks.find((t) => t.id === taskId)?.spec ?? `tasks/${taskId}.md`;
    const specPath = path.resolve(ctx.runDir, specRel);

    const worktreePath = path.join(
      ctx.repoRoot,
      ".substrate",
      "worktrees",
      `${taskId}-g${taskState.generation}`
    );

    let packet: FailurePacket;
    try {
      const safeRunId = /^r_[A-Z2-7]{12}$/.test(ctx.runId)
        ? ctx.runId
        : ("r_" + "2".repeat(12) as RunId);
      packet = await buildFailurePacket({
        runId: safeRunId,
        taskId,
        generation: taskState.generation,
        failureClass,
        specPath,
        attempts: [],
        worktreePath: fs.existsSync(worktreePath) ? worktreePath : ctx.repoRoot,
        baseRef: getRunBranch(ctx.runId),
        packetDir: packetsDir,
      });
      packet.run_id = ctx.runId;
      const jsonPath = path.join(packetsDir, `${taskId}-g${taskState.generation}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), "utf8");
    } catch {
      const patchPath = path.join(packetsDir, `${taskId}-g${taskState.generation}.patch`);
      if (!fs.existsSync(patchPath)) {
        fs.writeFileSync(patchPath, "", "utf8");
      }
      packet = {
        run_id: ctx.runId,
        task_id: taskId,
        generation: taskState.generation,
        failure_class: failureClass,
        spec_path: specPath,
        attempts: [],
        diff: { stat: "", patch_path: patchPath, truncated: false },
        verify_output: [],
        scope_violations: [],
        worker_summary: "",
        related_contracts: [],
        dependents: [],
      };
      const jsonPath = path.join(packetsDir, `${taskId}-g${taskState.generation}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), "utf8");
    }

    const altPacketPath = path.join(packetsDir, `${taskId}-g${taskState.generation}-packet.json`);
    fs.writeFileSync(altPacketPath, JSON.stringify(packet, null, 2), "utf8");

    const promptData = buildReplanPrompt(packet);
    const spawnReq: SpawnRequest = {
      role: "planner",
      cwd: ctx.runDir,
      prompt: promptData.user,
      system_append: promptData.system,
      model: escalation.route.model,
      permission: {
        allow: [ctx.runDir],
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
    // Cumulative usage conversion per planner session (R1.4).
    const prevUsageTotals = new Map<string, UsageTotals>();
    let localTotal = state.usage.total_usd;
    let sawUsageEvents = false;
    try {
      for await (const evt of handle.events) {
        if (evt.type === "usage" && (evt as any).record) {
          sawUsageEvents = true;
          const { delta, next } = toDelta(
            prevUsageTotals.get("session"),
            (evt as any).record,
            Boolean((evt as any).cumulative)
          );
          prevUsageTotals.set("session", next);
          emit("usage.recorded", {
            record: delta,
            role: "planner",
            task_id: taskId,
            generation: taskState.generation ?? 1,
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
        role: "planner",
        task_id: taskId,
        generation: taskState.generation ?? 1,
      });
      localTotal = localTotal + (res.usage.cost_usd ?? 0);
      if (checkRunBudget(ctx, emit, localTotal)) {
        return;
      }
    }

    if (ctx.signal?.aborted || res?.killed_for === "cancel") {
      try {
        await workspaceLifecycle.removeWorktree(ctx.repoRoot, worktreePath);
      } catch {}
      return;
    }

    try {
      await workspaceLifecycle.removeWorktree(ctx.repoRoot, worktreePath);
    } catch {}

    emit("task.replanned", {
      task_id: taskId,
      generation: escalation.generation,
    });

    emit("replan.finished", {
      task_id: taskId,
      generation: escalation.generation,
    });

    emit("task.ready", { task_id: taskId });
    return;
  }

  if (escalation.level === "L2") {
    (state as any).l2_done = true;
    (state as any).l2_count = ((state as any).l2_count ?? 0) + 1;

    const spawnReq: SpawnRequest = {
      role: "planner",
      cwd: ctx.runDir,
      prompt: "L2 replan: Amend contracts and manifest to resolve contract defect.",
      model: ctx.settings.roles?.planner?.model ?? "claude-haiku-5-5",
      permission: {
        allow: [ctx.runDir],
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
    // Cumulative usage conversion per planner session (R1.4).
    const prevUsageTotals = new Map<string, UsageTotals>();
    let localTotal = state.usage.total_usd;
    let sawUsageEvents = false;
    try {
      for await (const evt of handle.events) {
        if (evt.type === "usage" && (evt as any).record) {
          sawUsageEvents = true;
          const { delta, next } = toDelta(
            prevUsageTotals.get("session"),
            (evt as any).record,
            Boolean((evt as any).cumulative)
          );
          prevUsageTotals.set("session", next);
          emit("usage.recorded", {
            record: delta,
            role: "planner",
            task_id: taskId,
            generation: taskState.generation ?? 1,
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
        role: "planner",
        task_id: taskId,
        generation: taskState.generation ?? 1,
      });
      localTotal = localTotal + (res.usage.cost_usd ?? 0);
      if (checkRunBudget(ctx, emit, localTotal)) {
        return;
      }
    }

    if (ctx.signal?.aborted || res?.killed_for === "cancel") {
      return;
    }

    const manifestPath = path.join(ctx.runDir, "manifest.yaml");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
        if (manifest.contracts) {
          const commitSha = await commitContractStubs(
            ctx.repoRoot,
            ctx.runId,
            manifest.base_ref ?? "HEAD",
            manifest.contracts,
            ctx.runDir
          );
          emit("contracts.committed", { commit_sha: commitSha });
        }
      } catch {}
    }

    const otherTasks = Object.keys(state.tasks).filter((id) => id !== taskId);
    emit("tasks.invalidated", { task_ids: otherTasks });

    for (const otherId of otherTasks) {
      emit("task.ready", { task_id: otherId });
    }

    const nextGen = (taskState.generation ?? 1) + 1;
    emit("task.replanned", {
      task_id: taskId,
      generation: nextGen,
    });

    emit("replan.finished", {
      task_id: taskId,
      generation: nextGen,
    });

    emit("task.ready", { task_id: taskId });

    return;
  }

  emit("task.blocked", { task_id: taskId });
  emit("run.paused", { reason: "needs_human" });
}
