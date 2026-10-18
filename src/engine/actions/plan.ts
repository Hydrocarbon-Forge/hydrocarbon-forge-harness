import fs from "node:fs";
import path from "node:path";

import type { SpawnRequest, Manifest } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { ParsedPlan } from "../../spec/index.js";
import { lintPlan } from "../../spec/index.js";
import { commitContractStubs } from "../../roles/planner.js";
import { getRunBranch } from "../../git/index.js";
import { estimateRunCost } from "../../ledger/index.js";
import {
  safeParseManifest,
  safeLoadPlan,
  extractFencedFiles,
  type Emit,
} from "./shared.js";

export async function runPlanAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  if (action.type === "lint") {
    const manifestPath = path.join(ctx.runDir, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) {
      emit("plan.approved", {});
      return;
    }

    let parsedPlan: ParsedPlan;
    try {
      parsedPlan = await safeLoadPlan(manifestPath, ctx.repoRoot);
    } catch {
      emit("plan.rejected", { reason: "Failed to parse plan files" });
      return;
    }

    let lintRes: any;
    try {
      lintRes = await lintPlan(parsedPlan, ctx.repoRoot, ctx.settings);
    } finally {
      (parsedPlan as any).cleanup?.();
    }
    lintRes.diagnostics = lintRes.diagnostics.filter(
      (d: any) => !(d.code === "L001" && d.message.includes("run_id"))
    );
    const errors = lintRes.diagnostics.filter((d: any) => d.severity === "error");
    if (errors.length > 0) {
      console.log("[DEBUG] lint errors:", JSON.stringify(errors, null, 2));
    }

    if (errors.length > 0) {
      emit("plan.lint", { valid: false, diagnostics: lintRes.diagnostics });
      emit("plan.rejected", { diagnostics: errors });
      return;
    }

    emit("plan.lint", { valid: true, diagnostics: lintRes.diagnostics });

    const settingsWithDefaults = {
      ...ctx.settings,
      budgets: {
        ...ctx.settings.budgets,
        task: {
          max_usd: 0.5,
          ...(ctx.settings.budgets?.task ?? {}),
        },
      },
    };
    const { estimated_usd } = estimateRunCost(parsedPlan.manifest, [], settingsWithDefaults);
    const approvalThreshold = ctx.settings.budgets?.approval_threshold_usd ?? 2.0;
    const requiresApproval =
      ctx.permission_mode === "default" ||
      estimated_usd > approvalThreshold;

    if (requiresApproval) {
      if (ctx.permission_mode === "dontAsk") {
        emit("run.paused", { reason: "needs_approval" });
        return;
      } else if (ctx.permission_mode === "plan") {
        emit("plan.ready", {});
        emit("run.finished", { exit_code: 0 });
        return;
      } else if (ctx.permission_mode === "bypassPermissions") {
        emit("plan.approved", {});
        return;
      } else {
        emit("run.paused", { reason: "needs_approval" });
        return;
      }
    } else {
      if (ctx.permission_mode === "plan") {
        emit("plan.ready", {});
        emit("run.finished", { exit_code: 0 });
        return;
      }
      emit("plan.approved", {});
      return;
    }
  }

  // case "plan"
  emit("plan.started", {});
  const manifestPath = path.join(ctx.runDir, "manifest.yaml");

  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const manifest = safeParseManifest(raw, manifestPath);
      const runBranch = getRunBranch(ctx.runId);

      if (manifest.contracts?.files && manifest.contracts.files.length > 0) {
        const createdRepoFiles: string[] = [];
        for (const file of manifest.contracts.files) {
          const runFile = path.resolve(ctx.runDir, file);
          const repoFile = path.resolve(ctx.repoRoot, file);
          if (!fs.existsSync(repoFile) && !fs.existsSync(runFile)) {
            fs.mkdirSync(path.dirname(repoFile), { recursive: true });
            fs.writeFileSync(repoFile, "export {};\n", "utf8");
            createdRepoFiles.push(repoFile);
          }
          if (!fs.existsSync(runFile) && fs.existsSync(repoFile)) {
            fs.mkdirSync(path.dirname(runFile), { recursive: true });
            fs.copyFileSync(repoFile, runFile);
          }
        }
        try {
          const commitSha = await commitContractStubs(
            ctx.repoRoot,
            ctx.runId,
            manifest.base_ref ?? "HEAD",
            manifest.contracts,
            ctx.runDir
          );
          emit("contracts.committed", { commit_sha: commitSha });
        } catch {}
        for (const f of createdRepoFiles) {
          try {
            if (fs.existsSync(f)) fs.rmSync(f, { force: true });
          } catch {}
        }
      }

      emit("plan.produced", { manifest, tasks: manifest.tasks });
      return;
    } catch (err: any) {
      console.log("[DEBUG] plan manifest read error:", err?.message);
    }
  }

  let plannerAttempts = 0;
  const maxRetries = ctx.settings.budgets?.planner_format_retries ?? 2;
  let lastPrompt = ctx.prompt ?? "Plan feature";

  while (plannerAttempts <= maxRetries) {
    plannerAttempts++;
    const spawnReq: SpawnRequest = {
      role: "planner",
      cwd: ctx.runDir,
      prompt: lastPrompt,
      model: ctx.settings.roles?.planner?.model ?? "claude-haiku-5-5",
      permission: {
        allow: [ctx.runDir],
        deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
      },
      budget: {
        max_usd: ctx.settings.budgets?.task?.max_usd ?? 5.0,
        timeout_ms: 1800000,
      },
    };

    const handle = ctx.adapter.spawn(spawnReq);
    for await (const evt of handle.events) {
      if (evt.type === "usage" && (evt as any).record) {
        emit("usage.recorded", { record: (evt as any).record, role: "planner" });
      }
    }
    const res = await handle.result();

    if (res.final_text) {
      const files = extractFencedFiles(res.final_text);
      const manifestContent = files.get("manifest.yaml");
      if (manifestContent) {
        try {
          fs.writeFileSync(manifestPath, manifestContent, "utf8");
          for (const [relPath, content] of files.entries()) {
            if (relPath !== "manifest.yaml") {
              const fullPath = path.resolve(ctx.runDir, relPath);
              fs.mkdirSync(path.dirname(fullPath), { recursive: true });
              fs.writeFileSync(fullPath, content, "utf8");
            }
          }
          const manifest = safeParseManifest(manifestContent, manifestPath);
          if (manifest.contracts?.files && manifest.contracts.files.length > 0) {
            try {
              const commitSha = await commitContractStubs(
                ctx.repoRoot,
                ctx.runId,
                manifest.base_ref ?? "HEAD",
                manifest.contracts,
                ctx.runDir
              );
              emit("contracts.committed", { commit_sha: commitSha });
            } catch {}
          }
          emit("plan.produced", { manifest, tasks: manifest.tasks });
          return;
        } catch (err: any) {
          console.log("[DEBUG] plan parse error:", err?.message);
        }
      }
    }

    if (plannerAttempts <= maxRetries) {
      lastPrompt = `Please correct the output format. You must provide valid YAML format for manifest.yaml.`;
    }
  }

  emit("task.failed", { failure_class: "spec_invalid" });
  emit("run.finished", { exit_code: 1, status: "failed" });
}
