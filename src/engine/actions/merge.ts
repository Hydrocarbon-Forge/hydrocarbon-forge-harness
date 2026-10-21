import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest, TaskId } from "../../contracts/index.js";
import { matchGlob } from "../../util/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { checkBaseVerify, integrationFailureDetail, safeParseManifest } from "./shared.js";
import { withRepoLock } from "../../git/repo-lock.js";
import {
  advanceRunRef,
  createIntegrationWorktree,
  getRunBranch,
  getTaskBranch,
  mergeInto,
  preflight,
  verifyIn,
} from "../../git/index.js";

/**
 * The tasks a conflicting task collided with: the earlier tasks of this batch and the tasks
 * already merged into the run branch whose write or create patterns match a conflicting file.
 * When no pattern matches (a conflict in a file no spec declared), the earlier batch tasks
 * are named instead, so the message always says which tasks were merged before it.
 */
function collidingTasks(
  state: EngineState,
  earlier: TaskId[],
  taskId: TaskId,
  files: string[],
): TaskId[] {
  const merged = Object.values(state.tasks)
    .filter((t) => t.state === "MERGED" && t.id !== taskId)
    .map((t) => t.id);
  const candidates = [...new Set([...earlier, ...merged])];
  const matched = candidates.filter((id) => {
    const patterns = [...(state.tasks[id]?.write ?? []), ...(state.tasks[id]?.create ?? [])];
    return files.some((file) => patterns.some((p) => matchGlob(p, file)));
  });
  return matched.length > 0 ? matched : earlier;
}

export async function runMergeAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const batch = action.batch ?? [];
  if (batch.length === 0) {
    return;
  }

  // R8.2: a batch merges into the run branch through the integration worktree and never
  // touches the checkout, so uncommitted changes in the user's checkout do not stop it. The
  // checkout is checked where the work lands (`substrate merge` and the run's merge flag).
  const manifestPath = join(ctx.runDir, "manifest.yaml");
  let manifest: Manifest | undefined;
  if (existsSync(manifestPath)) {
    try {
      manifest = safeParseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    } catch {}
  }
  const verifyCommands = manifest?.integration_verify ?? [];

  // Behavior 8: base check before the first batch (advisory; see checkBaseVerify)
  await checkBaseVerify(ctx, manifest);

  const runBranch = getRunBranch(ctx.runId);
  const preBatchSha = execFileSync("git", ["rev-parse", runBranch], {
    cwd: ctx.repoRoot,
    encoding: "utf8",
  }).trim();

  // R8.3: the git steps of a merge run under the repo lock; the verify commands do not.
  const integrationWorktree = await withRepoLock(ctx.repoRoot, () =>
    createIntegrationWorktree(ctx.repoRoot, ctx.runId, preBatchSha)
  );
  let integrationHead = preBatchSha;

  for (const taskId of batch) {
    const taskState = state.tasks[taskId];
    const gen = taskState?.generation ?? 1;
    const taskBranch = getTaskBranch(ctx.runId, taskId, gen);

    let pf;
    try {
      pf = await withRepoLock(ctx.repoRoot, () => preflight(ctx.repoRoot, integrationHead, taskBranch));
    } catch (err: any) {
      pf = { clean: false, conflictFiles: [err?.message ?? "preflight failed"] };
    }

    if (!pf.clean) {
      // R8.1: the change that does not merge is dropped (no replan), and the message names
      // the tasks it collided with. Nothing of this batch's conflicted merge reaches the run
      // ref; the tasks merged before it stay, and the rest of the run continues.
      const collided = collidingTasks(state, batch.slice(0, batch.indexOf(taskId)), taskId, pf.conflictFiles);
      emit("merge.conflict", {
        task_id: taskId,
        conflict_files: pf.conflictFiles,
      });
      emit("task.failed", {
        task_id: taskId,
        failure_class: "merge_conflict",
        can_replan: false,
        detail: `conflicts with ${collided.join(", ") || "the run branch"} on ${pf.conflictFiles.join(", ")}`,
      });
      return;
    }

    integrationHead = await withRepoLock(ctx.repoRoot, () =>
      mergeInto(integrationWorktree, taskBranch, `merge: task ${taskId}`)
    );
  }

  const batchVerify = await verifyIn(
    integrationWorktree,
    verifyCommands,
    ctx.settings
  );
  if (batchVerify.passed) {
    await withRepoLock(ctx.repoRoot, () =>
      advanceRunRef(ctx.repoRoot, ctx.runId, integrationHead, preBatchSha)
    );
    for (const taskId of batch) {
      emit("task.merged", { task_id: taskId });
    }
    emit("batch.merged", { batch, checkpoint_ref: preBatchSha });
    return;
  }

  // Bisect
  emit("bisect.started", {});

  execFileSync("git", ["reset", "--hard", preBatchSha], {
    cwd: integrationWorktree,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("git", ["clean", "-fd"], {
    cwd: integrationWorktree,
    encoding: "utf8",
    stdio: "pipe",
  });

  let culprit = batch[batch.length - 1];
  let lastGoodSha = preBatchSha;
  // The failure the culprit's task carries: the batch's own, unless bisect pins one on a task.
  let culpritFailure = batchVerify.failure;

  for (const taskId of batch) {
    const taskState = state.tasks[taskId];
    const gen = taskState?.generation ?? 1;
    const taskBranch = getTaskBranch(ctx.runId, taskId, gen);

    const newHead = await withRepoLock(ctx.repoRoot, () =>
      mergeInto(integrationWorktree, taskBranch, `bisect: ${taskId}`)
    );

    const outcome = await verifyIn(
      integrationWorktree,
      verifyCommands,
      ctx.settings
    );
    if (!outcome.passed) {
      culprit = taskId;
      culpritFailure = outcome.failure;
      execFileSync("git", ["reset", "--hard", lastGoodSha], {
        cwd: integrationWorktree,
        encoding: "utf8",
        stdio: "pipe",
      });
      execFileSync("git", ["clean", "-fd"], {
        cwd: integrationWorktree,
        encoding: "utf8",
        stdio: "pipe",
      });
      break;
    }
    lastGoodSha = newHead;
  }

  emit("bisect.culprit", { culprit_task_id: culprit });
  const detail = culpritFailure
    ? integrationFailureDetail(culpritFailure, [integrationWorktree, ctx.repoRoot])
    : undefined;
  emit("task.failed", {
    task_id: culprit,
    failure_class: "integration_failed",
    ...(detail ? { message: detail.message } : {}),
  });
}
