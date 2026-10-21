import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { checkBaseVerify, integrationFailureDetail, safeParseManifest } from "./shared.js";
import { withRepoLock } from "../../git/repo-lock.js";
import {
  createIntegrationWorktree,
  getRunBranch,
  verifyIn,
} from "../../git/index.js";

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
  } else {
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
}
