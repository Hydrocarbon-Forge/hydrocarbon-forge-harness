import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { TaskSpecFrontmatter } from "../../contracts/index.js";
import type { EffectContext, EngineAction } from "../effects.js";
import type { EngineState } from "../reducer.js";
import { computeDagLayers } from "../reducer.js";
import { getRunBranch, workspaceManager } from "../../git/index.js";
import { parseTaskSpec } from "../../spec/index.js";
import { safeParseManifest, type Emit } from "./shared.js";

export async function runSetupAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const manifestPath = path.join(ctx.runDir, "manifest.yaml");
  const runBranch = getRunBranch(ctx.runId);
  await workspaceManager.createRunBranch(ctx.repoRoot, ctx.runId, "HEAD");

  if (!fs.existsSync(manifestPath)) {
    emit("setup.done", {});
    return;
  }

  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = safeParseManifest(raw, manifestPath);

  if (manifest.tasks.length === 0) {
    emit("setup.done", {});
    emit("batch.started", { batch: [] });
    // Empty batch: the checkpoint is the run branch's base (HEAD at creation).
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ctx.repoRoot,
      encoding: "utf8",
    }).trim();
    emit("batch.merged", { batch: [], checkpoint_ref: baseSha });
    emit("integration.finished", { passed: true });
    emit("run.finished", { exit_code: 0 });
    return;
  }

  const specMap = new Map<string, TaskSpecFrontmatter>();
  for (const t of manifest.tasks) {
    const full = path.resolve(ctx.runDir, t.spec);
    if (fs.existsSync(full)) {
      const specRaw = fs.readFileSync(full, "utf8");
      const parsed = parseTaskSpec(specRaw, full);
      specMap.set(t.id, parsed.frontmatter);
    }
  }

  const tasksWithDeps = manifest.tasks.map((t) => ({
    id: t.id,
    depends_on: specMap.get(t.id)?.depends_on ?? [],
  }));

  const layers = computeDagLayers(tasksWithDeps);
  emit("setup.done", {});

  if (layers.length > 0 && layers[0].length > 0) {
    emit("batch.started", { batch: layers[0] });
    for (const taskId of layers[0]) {
      emit("task.ready", { task_id: taskId });
    }
  }
}
