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
 * diagnostic without filtering, and then hands the plan on. There is no approval
 * pause (owner, 2026-10-23): only the plan permission mode stops at a planned plan.
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
    // The estimate is reported with the lint result. It is advisory and never pauses or refuses the plan.
    const { estimated_usd } = estimateRunCost(parsedPlan.manifest, [], parsedPlan.specs);
    emit("plan.lint", { valid: !lintRes.hasErrors, diagnostics: lintRes.diagnostics, estimated_usd });

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

  if (ctx.permission_mode === "plan") {
    emit("plan.ready", {});
    emit("run.finished", { exit_code: 0, status: "planned", reason: "planned" });
    return;
  }

  emit("plan.approved", {});
}
