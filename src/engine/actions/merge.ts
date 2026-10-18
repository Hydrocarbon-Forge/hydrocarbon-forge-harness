import { execFileSync } from "node:child_process";

import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { getRunBranch, getTaskBranch, TaskMergerImpl } from "../../git/index.js";

export async function runMergeAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const batch = action.batch ?? [];
  const runBranch = getRunBranch(ctx.runId);
  const merger = new TaskMergerImpl();

  const statusOut = execFileSync("git", ["-C", ctx.repoRoot, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim();
  if (statusOut.length > 0) {
    const files: string[] = [];
    for (const line of statusOut.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let filePath = line.slice(3).trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1].trim();
      }
      files.push(filePath);
    }
    emit("run.finished", {
      exit_code: 2,
      status: "failed",
      reason: "dirty_checkout",
      files,
    });
    return;
  }

  if (!ctx.preBatchCheckpoint) {
    try {
      ctx.preBatchCheckpoint = execFileSync("git", ["rev-parse", runBranch], {
        cwd: ctx.repoRoot,
        encoding: "utf8",
      }).trim();
    } catch {}
  }

  for (const taskId of batch) {
    const taskState = state.tasks[taskId];
    const gen = taskState?.generation ?? 1;
    const taskBranch = getTaskBranch(ctx.runId, taskId, gen);

    const pf = await merger.preflight(ctx.repoRoot, runBranch, taskBranch);
    if (!pf.clean) {
      emit("merge.conflict", {
        task_id: taskId,
        conflict_files: pf.conflictFiles,
      });
      emit("task.failed", {
        task_id: taskId,
        failure_class: "merge_conflict",
      });
      return;
    }

    await merger.mergeTask(
      ctx.repoRoot,
      runBranch,
      taskBranch,
      `merge: task ${taskId}`
    );
    emit("task.merged", { task_id: taskId });
  }
}
