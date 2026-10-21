import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Command, Manifest, TaskId } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import {
  cleanIntegrationText,
  INTEGRATION_COMMAND_MAX,
  integrationFailureDetail,
  safeParseManifest,
} from "./shared.js";
import { classifySetupFailure, classifyVerifyFailure } from "../verify-outcome.js";
import { resolveBaseRef } from "../../git/base-ref.js";
import { withRepoLock } from "../../git/repo-lock.js";
import {
  createIntegrationWorktree,
  getRunBranch,
  getTaskBranch,
  mergeInto,
  setUpWorktree,
  verifyIn,
  type SetupOutcome,
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

/** True when the task's branch of that generation exists (a swept branch cannot be merged again). */
function taskBranchExists(ctx: EffectContext, taskId: TaskId, generation: number): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", getTaskBranch(ctx.runId, taskId, generation)], {
      cwd: ctx.repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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

/** The commands of the final check: the plan's setup, and its integration_verify. */
interface IntegrationChecks {
  setup: Command[];
  verify: Command[];
}

/**
 * Verifies the run's first k merged tasks, merged onto the base commit in merge order. The setup
 * runs in the worktree first (once; see setUpWorktree), as it does for the final verify.
 */
async function prefixPasses(
  ctx: EffectContext,
  state: EngineState,
  baseSha: string,
  prefix: TaskId[],
  checks: IntegrationChecks
): Promise<boolean> {
  const worktree = await withRepoLock(ctx.repoRoot, () =>
    createIntegrationWorktree(ctx.repoRoot, ctx.runId, baseSha)
  );
  for (const taskId of prefix) {
    const generation = state.tasks[taskId]?.generation ?? 1;
    const branch = getTaskBranch(ctx.runId, taskId, generation);
    await withRepoLock(ctx.repoRoot, () => mergeInto(worktree, branch, `bisect: ${taskId}`));
  }
  const setup = await setUpWorktree(worktree, checks.setup);
  if (setup !== undefined && !setup.passed) return false;
  return (await verifyIn(worktree, checks.verify, ctx.settings)).passed;
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
  checks: IntegrationChecks
): Promise<TaskId | undefined> {
  const order = mergeOrder(ctx, state);
  // R10.4: a run that failed and was reopened has had its task branches swept, so a prefix cannot be
  // merged again. Without them no task can be blamed; the run fails with the verify output instead.
  if (!order.every((id) => taskBranchExists(ctx, id, state.tasks[id]?.generation ?? 1))) return undefined;
  const baseSha = resolveBaseRef(ctx.repoRoot, manifest?.base_ref).sha;
  // The base anchors the search (the empty prefix). It is verified here, only now that the final verify
  // has failed, so a passing run never pays for it and no note about it is printed (R12.2). A base that
  // fails leaves no anchor: nothing can then be shown to pass, so nothing is blamed.
  let lastPassing: number | undefined =
    (await prefixPasses(ctx, state, baseSha, [], checks)) ? 0 : undefined;
  for (let k = 1; k <= order.length; k++) {
    if (!isBlameablePrefix(state, order, k)) continue;
    // The full order is the verify that failed, so it is not run again.
    const passes = k < order.length
      ? await prefixPasses(ctx, state, baseSha, order.slice(0, k), checks)
      : false;
    if (!passes) return lastPassing === k - 1 ? order[k - 1] : undefined;
    lastPassing = k;
  }
  return undefined;
}

/** The event data for a setup that finished: passed, or the command that failed and how. */
function setupFinishedData(outcome: SetupOutcome, roots: string[]): {
  passed: boolean;
  command?: string;
  exit_code?: number;
  timed_out?: boolean;
} {
  if (outcome.passed) return { passed: true };
  const { command, exit_code, timed_out } = outcome.failure;
  return {
    passed: false,
    command: cleanIntegrationText(command, roots).slice(0, INTEGRATION_COMMAND_MAX),
    ...(exit_code !== null ? { exit_code } : {}),
    ...(timed_out ? { timed_out: true } : {}),
  };
}

/**
 * The final gate (R9.1): integration_verify runs once, on the run branch, after every task of the
 * plan has merged. The plan's setup runs in the integration worktree first (once per worktree).
 * A pass finishes the run. A failure names a culprit when bisect can isolate one (its task is
 * replanned, as before); otherwise the run fails with the verify output. A check that could not run
 * (R12.2) finishes the run with exit 0 and a warning: the work is merged but not verified as a whole.
 * A plan with one task is not verified again: its own checks ran in its worktree (R12.2).
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
  const checks: IntegrationChecks = {
    setup: manifest?.setup ?? [],
    verify: manifest?.integration_verify ?? [],
  };

  // R12.2: with one task the run branch is base plus that task, which its own verify covered.
  if (checks.verify.length > 0 && Object.keys(state.tasks).length === 1) {
    emit("integration.skipped", { reason: "single_task" });
    emit("run.finished", { exit_code: 0 });
    return;
  }

  const runBranch = getRunBranch(ctx.runId);
  const runBranchSha = execFileSync("git", ["rev-parse", runBranch], {
    cwd: ctx.repoRoot,
    encoding: "utf8",
  }).trim();

  const integrationWorktree = await withRepoLock(ctx.repoRoot, () =>
    createIntegrationWorktree(ctx.repoRoot, ctx.runId, runBranchSha)
  );

  // The setup belongs to the final check, and a plan without integration_verify has no check to set up for.
  const roots = [integrationWorktree, ctx.repoRoot];
  const setup = checks.verify.length > 0
    ? await setUpWorktree(integrationWorktree, checks.setup, {
        onStart: (count) => emit("integration.setup.started", { commands: count }),
        onFinish: (outcome) => emit("integration.setup.finished", setupFinishedData(outcome, roots)),
      })
    : undefined;
  if (setup !== undefined && !setup.passed) {
    // A setup that failed means the tooling was never installed: the check could not run (R12.2).
    const verdict = classifySetupFailure(setup.failure);
    emit("integration.could_not_run", {
      command: cleanIntegrationText(setup.failure.command, roots).slice(0, INTEGRATION_COMMAND_MAX),
      reason: verdict.reason,
    });
    emit("run.finished", { exit_code: 0 });
    return;
  }

  emit("integration.started", {});
  const verify = await verifyIn(integrationWorktree, checks.verify, ctx.settings);

  if (verify.passed) {
    emit("integration.finished", { passed: true });
    emit("run.finished", { exit_code: 0 });
    return;
  }

  const verdict = classifyVerifyFailure(verify.failure);
  if (verdict.verdict === "could_not_run") {
    const detail = integrationFailureDetail(verify.failure, roots);
    emit("integration.could_not_run", { command: detail.command, reason: verdict.reason });
    emit("run.finished", { exit_code: 0 });
    return;
  }

  const culprit = await isolateCulprit(ctx, state, manifest, checks);
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
