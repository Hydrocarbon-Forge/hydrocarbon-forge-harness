import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { safeParseManifest } from "./shared.js";
import { resolveBaseRef } from "../../git/base-ref.js";
import {
  advanceRunRef,
  createIntegrationWorktree,
  getRunBranch,
  getTaskBranch,
  mergeInto,
  preflight,
  verifyIn,
} from "../../git/index.js";

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

  const statusOut = execFileSync(
    "git",
    ["-C", ctx.repoRoot, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" }
  ).trim();
  if (statusOut.length > 0) {
    const files: string[] = [];
    for (const line of statusOut.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let filePath = trimmed.replace(/^(\?\?|[MADRCU?!]+)\s+/, "");
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

  const manifestPath = join(ctx.runDir, "manifest.yaml");
  let manifest: Manifest | undefined;
  if (existsSync(manifestPath)) {
    try {
      manifest = safeParseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    } catch {}
  }
  const verifyCommands = manifest?.integration_verify ?? [];

  // Behavior 8: base-ref check before first batch
  if (verifyCommands.length > 0 && !ctx.baseChecked) {
    ctx.baseChecked = true;
    const baseSha = resolveBaseRef(ctx.repoRoot, manifest?.base_ref).sha;
    const baseWt = await createIntegrationWorktree(ctx.repoRoot, ctx.runId, baseSha);
    const baseVerified = await verifyIn(baseWt, verifyCommands, ctx.settings);
    if (!baseVerified) {
      emit("integration.failed", { base: true });
      emit("run.finished", { exit_code: 1, status: "failed" });
      return;
    }
  }

  const runBranch = getRunBranch(ctx.runId);
  const preBatchSha = execFileSync("git", ["rev-parse", runBranch], {
    cwd: ctx.repoRoot,
    encoding: "utf8",
  }).trim();

  const integrationWorktree = await createIntegrationWorktree(
    ctx.repoRoot,
    ctx.runId,
    preBatchSha
  );
  let integrationHead = preBatchSha;

  for (const taskId of batch) {
    const taskState = state.tasks[taskId];
    const gen = taskState?.generation ?? 1;
    const taskBranch = getTaskBranch(ctx.runId, taskId, gen);

    let pf;
    try {
      pf = await preflight(ctx.repoRoot, integrationHead, taskBranch);
    } catch (err: any) {
      pf = { clean: false, conflictFiles: [err?.message ?? "preflight failed"] };
    }

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

    integrationHead = await mergeInto(
      integrationWorktree,
      taskBranch,
      `merge: task ${taskId}`
    );
  }

  const verified = await verifyIn(
    integrationWorktree,
    verifyCommands,
    ctx.settings
  );
  if (verified) {
    await advanceRunRef(ctx.repoRoot, ctx.runId, integrationHead, preBatchSha);
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

  for (const taskId of batch) {
    const taskState = state.tasks[taskId];
    const gen = taskState?.generation ?? 1;
    const taskBranch = getTaskBranch(ctx.runId, taskId, gen);

    const newHead = await mergeInto(
      integrationWorktree,
      taskBranch,
      `bisect: ${taskId}`
    );

    const passed = await verifyIn(
      integrationWorktree,
      verifyCommands,
      ctx.settings
    );
    if (!passed) {
      culprit = taskId;
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
  emit("task.failed", {
    task_id: culprit,
    failure_class: "integration_failed",
  });
}
