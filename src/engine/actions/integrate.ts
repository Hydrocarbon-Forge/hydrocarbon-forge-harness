import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { Command, Manifest } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { safeParseManifest } from "./shared.js";
import {
  getRunBranch,
  getTaskBranch,
  BatchIntegrationMergerImpl,
} from "../../git/index.js";
import { VerifyRunner } from "../../verify/runner.js";

async function runIntegrationVerify(
  repoRoot: string,
  runBranch: string,
  verify: Command[]
): Promise<boolean> {
  if (!verify || verify.length === 0) {
    return true;
  }
  const tempDir = fs.mkdtempSync(path.join(repoRoot, ".substrate", "integ-"));
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", tempDir, runBranch],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );
    const runner = new VerifyRunner();
    const results = await runner.runVerify({
      cwd: tempDir,
      commands: verify,
      sandbox: false,
      network: "allow",
    });
    return runner.isAllPassed(results);
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", tempDir], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch {}
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function runIntegrateAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const manifestPath = path.join(ctx.runDir, "manifest.yaml");
  let manifest: Manifest | undefined;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
    } catch {}
  }

  const runBranch = getRunBranch(ctx.runId);
  const verifyCommands = manifest?.integration_verify ?? [];

  if (verifyCommands.length > 0 && !ctx.baseChecked) {
    ctx.baseChecked = true;
    const baseVerified = await runIntegrationVerify(
      ctx.repoRoot,
      manifest?.base_ref ?? "main",
      verifyCommands
    );
    if (!baseVerified) {
      emit("integration.failed", { base: true });
      emit("run.finished", { exit_code: 1, status: "failed" });
      return;
    }
  }

  const initialCheckpoint = ctx.preBatchCheckpoint ?? execFileSync(
    "git",
    ["rev-parse", runBranch],
    { cwd: ctx.repoRoot, encoding: "utf8" }
  ).trim();

  const verified = await runIntegrationVerify(
    ctx.repoRoot,
    runBranch,
    verifyCommands
  );

  if (verified) {
    ctx.preBatchCheckpoint = undefined;
    emit("integration.finished", { passed: true });
    const allTaskIds = Object.keys(state.tasks);
    emit("batch.merged", { batch: allTaskIds });
    emit("run.finished", { exit_code: 0 });
    return;
  }

  emit("integration.failed", {});

  const unmergedTasks = Object.values(state.tasks).filter((t) => t.state !== "MERGED");
  if (unmergedTasks.length === Object.keys(state.tasks).length) {
    emit("run.finished", { exit_code: 1, status: "failed" });
    return;
  }

  const batchMerger = new BatchIntegrationMergerImpl();
  const taskBranches = Object.values(state.tasks).map((t) => ({
    id: t.id,
    branch: getTaskBranch(ctx.runId, t.id, t.generation ?? 1),
  }));

  emit("bisect.started", {});
  const culprit = await batchMerger.bisectBatch(
    ctx.repoRoot,
    runBranch,
    initialCheckpoint,
    taskBranches,
    verifyCommands
  );

  emit("bisect.culprit", { culprit_task_id: culprit });
  emit("task.failed", {
    task_id: culprit,
    failure_class: "integration_failed",
  });

  try {
    ctx.preBatchCheckpoint = execFileSync("git", ["rev-parse", runBranch], {
      cwd: ctx.repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {}
}
