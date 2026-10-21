import fs from "node:fs";
import path from "node:path";

import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { safeLoadPlan } from "./shared.js";
import { lintPlan, type ParsedPlan } from "../../spec/index.js";
import { estimateRunCost } from "../../ledger/index.js";
import { log } from "../../util/log.js";

/**
 * The `lint` action: re-parses the plan the planner wrote, reports every
 * diagnostic without filtering, and applies the permission-mode approval rules.
 */
export async function runLintAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const manifestPath = path.join(ctx.runDir, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    emit("plan.approved", {});
    return;
  }

  let parsedPlan: ParsedPlan & { cleanup?: () => void };
  try {
    parsedPlan = await safeLoadPlan(manifestPath, ctx.repoRoot);
  } catch (err: any) {
    emit("plan.lint", { valid: false, diagnostics: [] });
    emit("plan.rejected", { reason: `Failed to parse plan files: ${err.message}` });
    return;
  }

  try {
    const lintRes = await lintPlan(parsedPlan, ctx.repoRoot, ctx.settings);
    emit("plan.lint", { valid: !lintRes.hasErrors, diagnostics: lintRes.diagnostics });

    if (lintRes.hasErrors) {
      emit(
        "plan.rejected",
        { diagnostics: lintRes.diagnostics.filter((d) => d.severity === "error") }
      );
      return;
    }
  } finally {
    parsedPlan.cleanup?.();
  }

  // The estimate pauses the run only when the caller set budgets.approval_threshold_usd (off by default).
  const { estimated_usd } = estimateRunCost(parsedPlan.manifest, [], ctx.settings, parsedPlan.specs);
  const approvalThreshold = ctx.settings.budgets?.approval_threshold_usd;
  const requiresApproval =
    ctx.permission_mode === "default" ||
    (approvalThreshold !== undefined && estimated_usd > approvalThreshold);

  if (requiresApproval) {
    if (ctx.permission_mode === "bypassPermissions") {
      emit("plan.approved", {});
      return;
    }
    if (ctx.permission_mode === "plan") {
      emit("plan.ready", {});
      emit("run.finished", { exit_code: 0, status: "planned", reason: "planned" });
      return;
    }
    emit("run.paused", { reason: "needs_approval" });
    return;
  }

  if (ctx.permission_mode === "plan") {
    emit("plan.ready", {});
    emit("run.finished", { exit_code: 0, status: "planned", reason: "planned" });
    return;
  }

  emit("plan.approved", {});
}

export function runApproveAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): void {
  emit("run.paused", { reason: action.reason ?? "needs_approval" });
}
