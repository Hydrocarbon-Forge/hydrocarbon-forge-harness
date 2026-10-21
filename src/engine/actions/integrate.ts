import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { checkBaseVerify, safeParseManifest } from "./shared.js";
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

  const integrationWorktree = await createIntegrationWorktree(
    ctx.repoRoot,
    ctx.runId,
    runBranchSha
  );

  emit(
    "integration.started",
    ctx.baseVerifyPassed === false ? { base_verify_passed: false } : {}
  );
  const verified = await verifyIn(
    integrationWorktree,
    verifyCommands,
    ctx.settings
  );

  if (verified) {
    emit("integration.finished", { passed: true });
    emit("run.finished", { exit_code: 0 });
  } else {
    emit("integration.failed", { base: false });
    emit("run.finished", { exit_code: 1, status: "failed" });
  }
}
