import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest, TaskId } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { checkBaseVerify, integrationFailureDetail, safeParseManifest } from "./shared.js";
import { resolveBaseRef } from "../../git/base-ref.js";
import { withRepoLock } from "../../git/repo-lock.js";
import {
  createIntegrationWorktree,
  getRunBranch,
  getTaskBranch,
  mergeInto,
  verifyIn,
} from "../../git/index.js";
import { EventStoreImpl } from "../../store/event-store.js";

/**
 * The MERGED tasks in the order they merged: each task's last task.merged event in the run's log.
 * A prefix of this order is the run's own history: the run branch held exactly these tasks at
 * that point, and every task branch brings in only earlier merges.
 */
function mergeOrder(ctx: EffectContext, state: EngineState): TaskId[] {
  const store = ctx.store ?? new EventStoreImpl(ctx.runId, { runDir: ctx.runDir });
  const order: TaskId[] = [];
  for (const evt of store.readAllSync()) {
    if (evt.type !== "task.merged") continue;
    const id = (evt.data as { task_id?: TaskId }).task_id;
    if (!id || state.tasks[id]?.state !== "MERGED") continue;
    const at = order.indexOf(id);
    if (at >= 0) order.splice(at, 1);
    order.push(id);
  }
  return order;
}

/**
 * A prefix of the merge order can be blamed only when no task outside it depends on a task inside
 * it. Otherwise a failure may exist only because the absent dependent is missing (a test-first
 * plan is red until its implementer merges), and bisect must not blame the prefix for it.
 */
function isBlameablePrefix(state: EngineState, order: TaskId[], k: number): boolean {
  const inside = new Set(order.slice(0, k));
  return order
    .slice(k)
    .every((id) => !(state.tasks[id]?.depends_on ?? []).some((dep) => inside.has(dep)));
}

/** Verifies the run's first k merged tasks, merged onto the base commit in merge order. */
async function prefixPasses(
  ctx: EffectContext,
  state: EngineState,
  baseSha: string,
  prefix: TaskId[],
  verifyCommands: Manifest["integration_verify"]
): Promise<boolean> {
  const worktree = await withRepoLock(ctx.repoRoot, () =>
    createIntegrationWorktree(ctx.repoRoot, ctx.runId, baseSha)
  );
  for (const taskId of prefix) {
    const generation = state.tasks[taskId]?.generation ?? 1;
    const branch = getTaskBranch(ctx.runId, taskId, generation);
    await withRepoLock(ctx.repoRoot, () => mergeInto(worktree, branch, `bisect: ${taskId}`));
  }
  return (await verifyIn(worktree, verifyCommands, ctx.settings)).passed;
}

/**
 * Names the one task whose merge breaks the final verify, or nothing (R9.1). The merge order's
 * prefixes are tested from the base upward, skipping prefixes that are not blameable. A culprit
 * is named only when the last blameable prefix that passes is the one just before the first that
 * fails: then the failing task is the single task added between them. Otherwise nothing is named
 * and the run fails with the verify output.
 */
async function isolateCulprit(
  ctx: EffectContext,
  state: EngineState,
  manifest: Manifest | undefined,
  verifyCommands: Manifest["integration_verify"]
): Promise<TaskId | undefined> {
  const order = mergeOrder(ctx, state);
  const baseSha = resolveBaseRef(ctx.repoRoot, manifest?.base_ref).sha;
  // The last blameable prefix known to pass. The empty prefix (the base) counts only when the base
  // check passed. A base that fails is expected when the run adds code, so the search cannot blame a
  // task that merely adds to a red base; a single-task run is blamed, since that task is the whole change.
  let lastPassing: number | undefined =
    ctx.baseVerifyPassed === true || order.length === 1 ? 0 : undefined;
  for (let k = 1; k <= order.length; k++) {
    if (!isBlameablePrefix(state, order, k)) continue;
    // The full order is the verify that failed, so it is not run again.
    const passes = k < order.length
      ? await prefixPasses(ctx, state, baseSha, order.slice(0, k), verifyCommands)
      : false;
    if (!passes) return lastPassing === k - 1 ? order[k - 1] : undefined;
    lastPassing = k;
  }
  return undefined;
}

/**
 * The final gate (R9.1): integration_verify runs once, on the run branch, after every task of the
 * plan has merged. A pass finishes the run. A failure names a culprit when bisect can isolate one
 * (its task is replanned, as before); otherwise the run fails with the verify output.
 */
export async function runIntegrateAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const manifestPath = join(ctx.runDir, "manifest.yaml");
  let manifest: Manifest | undefined;
  if (existsSync(manifestPath)) {
    try {
      manifest = safeParseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    } catch {}
  }
  const verifyCommands = manifest?.integration_verify ?? [];

  // Behavior 8: base check when no batch ran (e.g. 0 tasks planned); advisory (see checkBaseVerify)
  await checkBaseVerify(ctx, manifest);

  const runBranch = getRunBranch(ctx.runId);
  const runBranchSha = execFileSync("git", ["rev-parse", runBranch], {
    cwd: ctx.repoRoot,
    encoding: "utf8",
  }).trim();

  const integrationWorktree = await withRepoLock(ctx.repoRoot, () =>
    createIntegrationWorktree(ctx.repoRoot, ctx.runId, runBranchSha)
  );

  emit(
    "integration.started",
    ctx.baseVerifyPassed === false ? { base_verify_passed: false } : {}
  );
  const verify = await verifyIn(
    integrationWorktree,
    verifyCommands,
    ctx.settings
  );

  if (verify.passed) {
    emit("integration.finished", { passed: true });
    emit("run.finished", { exit_code: 0 });
    return;
  }

  const culprit = await isolateCulprit(ctx, state, manifest, verifyCommands);
  if (culprit !== undefined) {
    const detail = integrationFailureDetail(verify.failure, [integrationWorktree, ctx.repoRoot]);
    emit("bisect.started", {});
    emit("bisect.culprit", { culprit_task_id: culprit });
    emit("task.failed", {
      task_id: culprit,
      failure_class: "integration_failed",
      message: detail.message,
    });
    return;
  }

  const detail = integrationFailureDetail(verify.failure, [integrationWorktree, ctx.repoRoot]);
  emit("integration.failed", {
    failure_class: "integration_failed",
    message: detail.message,
    command: detail.command,
    ...(detail.exit_code !== null ? { exit_code: detail.exit_code } : {}),
    output_tail: detail.output_tail,
  });
  emit("run.finished", { exit_code: 1, status: "failed" });
}
