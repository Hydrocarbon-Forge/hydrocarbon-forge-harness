import fs from "node:fs";
import path from "node:path";

import {
  type FailureClass,
  type Manifest,
  type TaskId,
} from "../../contracts/index.js";
import { parseManifest, parseTaskSpec, type ParsedTaskSpec } from "../../spec/index.js";
import { EventStoreImpl } from "../../store/event-store.js";
import type { EffectContext, EngineAction } from "../effects.js";
import { interruptOf } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { adapterFor, safeParseManifest } from "./shared.js";
import { buildFailurePacket } from "../packet.js";
import { executeReplan } from "../replan.js";
import { getRunBranch } from "../../git/index.js";

const MANIFEST_FILE = "manifest.yaml";

export async function runReplanAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState,
  emit: Emit
): Promise<void> {
  const taskId = action.taskId;
  if (!taskId) return;

  const taskState = state.tasks[taskId] ?? {
    id: taskId,
    state: "FAILED",
    generation: 1,
    attempt: 2,
  };
  const generation = taskState.generation ?? 1;
  const failureClass: FailureClass = taskState.failure_class ?? "verify_failed";

  const packetsDir = path.join(ctx.runDir, "packets");

  const manifest = readManifest(ctx);
  const specRel = manifest?.tasks.find((t) => t.id === taskId)?.spec ?? `tasks/${taskId}.md`;
  const specPath = path.resolve(ctx.runDir, specRel);
  const spec = readSpec(ctx.runDir, specRel);

  // The worktree of the failed generation is what the packet diffs against the run
  // branch. Worker worktrees are never removed here: the packet has to be able to read
  // what the failed attempt actually changed.
  const worktreePath = path.join(
    ctx.repoRoot,
    ".substrate",
    "worktrees",
    ctx.runId,
    `${taskId}-g${generation}`
  );

  const packet = await buildFailurePacket({
    runId: ctx.runId,
    taskId,
    generation,
    failureClass,
    specPath,
    worktreePath: fs.existsSync(worktreePath) ? worktreePath : ctx.repoRoot,
    baseRef: getRunBranch(ctx.runId),
    packetDir: packetsDir,
    // `attempts` is left out: packet.ts reads the per-attempt report files the worker
    // action wrote, so the packet is built from what was recorded.
    scopeViolations: recordedScopeViolations(ctx, taskId, generation),
    relatedContracts: manifest
      ? (spec?.frontmatter.read ?? []).filter((entry) => manifest.contracts.files.includes(entry))
      : [],
    dependents: manifest ? transitiveDependents(ctx.runDir, manifest, taskId) : [],
  });

  // The ladder decides the route and executeReplan runs it: L1, L2 or the L3 pause.
  await executeReplan({
    runId: ctx.runId,
    taskId,
    packet,
    state,
    settings: ctx.settings,
    resolveAdapter: (backend) => adapterFor(ctx, backend) ?? undefined,
    runDir: ctx.runDir,
    repoRoot: ctx.repoRoot,
    baseRef: getRunBranch(ctx.runId),
    decisionsLog: readRunFile(ctx.runDir, "decisions.md"),
    taskClass: spec?.frontmatter.class,
    signal: interruptOf(ctx),
    ownerRoutings: recordedOwnerRoutings(ctx, taskId),
    // The effects-loop emitter: every replan event is recorded through it, so the
    // reducer advances the task and run state as the ladder escalates.
    emit,
  });
}

function readManifest(ctx: EffectContext): Manifest | undefined {
  const manifestPath = path.join(ctx.runDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    return safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
  } catch {
    return undefined;
  }
}

function readSpec(runDir: string, specRel: string): ParsedTaskSpec | undefined {
  const specPath = path.resolve(runDir, specRel);
  if (!fs.existsSync(specPath)) return undefined;
  try {
    return parseTaskSpec(fs.readFileSync(specPath, "utf8"), specRel);
  } catch {
    return undefined;
  }
}

/** Every task that transitively depends on `taskId`, in id order, from the plan. */
function transitiveDependents(runDir: string, manifest: Manifest, taskId: TaskId): TaskId[] {
  const found = new Set<TaskId>();

  const walk = (id: TaskId): void => {
    if (found.has(id)) return;
    found.add(id);
    for (const task of manifest.tasks) {
      const spec = readSpec(runDir, task.spec);
      if (spec?.frontmatter.depends_on.includes(id)) walk(task.id);
    }
  };

  walk(taskId);
  found.delete(taskId);
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Scope violations as they were recorded by the worker for this generation: the
 * `task.scope.checked` events, read back from the run log.
 */
function recordedScopeViolations(ctx: EffectContext, taskId: TaskId, generation: number): string[] {
  const events = ctx.store
    ? ctx.store.readAllSync()
    : new EventStoreImpl(ctx.runId, { runDir: ctx.runDir }).readAllSync();

  const violations: string[] = [];
  for (const evt of events) {
    if (evt.type !== "task.scope.checked") continue;
    const data = evt.data as { task_id?: string; generation?: number; violations?: string[] };
    if (data.task_id !== taskId || data.generation !== generation) continue;
    for (const violation of data.violations ?? []) violations.push(violation);
  }
  return violations;
}

/** The owner routings this task has taken: the `plan.synced` events that carry an `owner_route` for it (item 88). */
function recordedOwnerRoutings(ctx: EffectContext, taskId: TaskId): number {
  const events = ctx.store
    ? ctx.store.readAllSync()
    : new EventStoreImpl(ctx.runId, { runDir: ctx.runDir }).readAllSync();

  let routings = 0;
  for (const evt of events) {
    if (evt.type !== "plan.synced") continue;
    const data = evt.data as { replan_task_id?: string; owner_route?: unknown };
    if (data.replan_task_id === taskId && data.owner_route !== undefined) routings += 1;
  }
  return routings;
}

function readRunFile(runDir: string, relPath: string): string {
  try {
    return fs.readFileSync(path.resolve(runDir, relPath), "utf8");
  } catch {
    return "";
  }
}
