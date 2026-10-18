import fs from "node:fs";
import path from "node:path";
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

  try {
    const statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: ctx.repoRoot,
      encoding: "utf8",
    });
    for (const line of statusOut.split("\n")) {
      if (line.startsWith("?? ")) {
        const rel = line.slice(3).trim();
        if (!rel.startsWith(".substrate")) {
          try {
            fs.rmSync(path.resolve(ctx.repoRoot, rel), { recursive: true, force: true });
          } catch {}
        }
      }
    }
  } catch {}

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
