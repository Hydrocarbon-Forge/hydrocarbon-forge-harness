import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { TaskId, TaskSpecFrontmatter } from "../../contracts/index.js";
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

  const specMap = new Map<TaskId, TaskSpecFrontmatter>();
  for (const t of manifest.tasks) {
    const full = path.resolve(ctx.runDir, t.spec);
    if (fs.existsSync(full)) {
      const specRaw = fs.readFileSync(full, "utf8");
      const parsed = parseTaskSpec(specRaw, full);
      specMap.set(t.id, parsed.frontmatter);
    }
  }

  const taskList = manifest.tasks.map((t) => {
    const frontmatter = specMap.get(t.id);
    return {
      id: t.id,
      depends_on: frontmatter?.depends_on ?? [],
      write: frontmatter?.write ?? [],
      create: frontmatter?.create ?? [],
    };
  });

  // Dependency cycles are rejected here; scheduling itself is done by
  // `promoteReadyTasks`, which only releases a dependent once every dependency
  // has been merged.
  computeDagLayers(taskList.map((t) => ({ id: t.id, depends_on: t.depends_on })));

  emit("setup.done", { tasks: taskList });

  const firstBatch = taskList.filter((t) => t.depends_on.length === 0).map((t) => t.id);
  if (firstBatch.length > 0) {
    emit("batch.started", { batch: firstBatch });
    for (const taskId of firstBatch) {
      emit("task.ready", { task_id: taskId });
    }
  }
}
