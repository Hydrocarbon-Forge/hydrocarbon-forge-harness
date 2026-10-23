import fs from "node:fs";
import path from "node:path";

import type { TaskId } from "../contracts/index.js";
import { parseManifest, parseTaskSpec } from "../spec/index.js";
import type { EngineState, TaskRuntimeState } from "./reducer.js";

// 2026-10-23 (owner): the manifest the run directory holds and the engine's live task state must agree. A replan or
// an amendment rewrites the manifest and the specs; this module compares what the manifest says with what the state
// has, and reports the difference as a `plan.synced` event (see PlanSyncedEvent). A dependency that names no task of
// the plan is dropped and reported, never silently kept: a task would otherwise wait for a task that never runs.

const MANIFEST_FILE = "manifest.yaml";
const WARNING_MAX = 300;

export interface PlanSyncTask {
  id: string;
  depends_on: string[];
  write: string[];
  create: string[];
}

export interface PlanSync {
  added: string[];
  changed: string[];
  dropped: string[];
  tasks: PlanSyncTask[];
  repaired_dependencies: { task: string; dependency: string }[];
  warnings: string[];
}

/** The tasks a sync may change: pending ones, a dropped one the manifest names again, or the task a replan works on. */
function changeable(task: TaskRuntimeState, replanTaskId: string | undefined): boolean {
  if (task.id === replanTaskId) return true;
  if (task.state === "PENDING" || task.state === "READY") return true;
  return task.state === "ABANDONED" && task.dropped === true;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function clip(text: string): string {
  return text.length > WARNING_MAX ? `${text.slice(0, WARNING_MAX - 3)}...` : text;
}

/** An empty sync: nothing to change. */
export function emptyPlanSync(): PlanSync {
  return { added: [], changed: [], dropped: [], tasks: [], repaired_dependencies: [], warnings: [] };
}

/** True when the sync has anything to record or to apply. */
export function hasPlanSyncChanges(sync: PlanSync): boolean {
  return (
    sync.added.length > 0 ||
    sync.changed.length > 0 ||
    sync.dropped.length > 0 ||
    sync.repaired_dependencies.length > 0 ||
    sync.warnings.length > 0
  );
}

/**
 * The difference between the run directory's manifest (with its specs) and the live state. Pure: it reads the
 * files and the state, and changes neither. A run directory with no manifest (a solo run) has nothing to sync.
 * `replanTaskId` names the task a replan is working on; its state is left to the replan, its sets are not.
 */
export function planSync(runDir: string, state: EngineState, replanTaskId?: string): PlanSync {
  const out = emptyPlanSync();
  const manifestPath = path.join(runDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return out;

  let manifest;
  try {
    manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
  } catch (err: any) {
    out.warnings.push(clip(`the plan's manifest could not be read, so its tasks were not reconciled: ${err?.message ?? String(err)}`));
    return out;
  }

  const planIds = new Set<string>(manifest.tasks.map((t) => t.id));
  const specs = new Map<string, { depends_on: string[]; write: string[]; create: string[] }>();
  const declared: { task: string; dependency: string }[] = [];

  for (const task of manifest.tasks) {
    let frontmatter;
    try {
      frontmatter = parseTaskSpec(fs.readFileSync(path.resolve(runDir, task.spec), "utf8"), task.spec).frontmatter;
    } catch (err: any) {
      out.warnings.push(clip(`task ${task.id}: its spec ${task.spec} could not be read (${err?.message ?? String(err)}), so its dependencies were not reconciled`));
      continue;
    }
    const deps = frontmatter.depends_on ?? [];
    for (const dep of deps) {
      if (!planIds.has(dep)) declared.push({ task: task.id, dependency: dep });
    }
    specs.set(task.id, {
      depends_on: deps.filter((dep) => planIds.has(dep)),
      write: frontmatter.write ?? [],
      create: frontmatter.create ?? [],
    });
  }

  // A dropped dependency is reported once: when the state still names it (or the task is not registered yet).
  for (const { task, dependency } of declared) {
    const current = state.tasks[task as TaskId];
    const reportable = current === undefined || (changeable(current, replanTaskId) && (current.depends_on ?? []).includes(dependency));
    if (!reportable) continue;
    out.repaired_dependencies.push({ task, dependency });
    out.warnings.push(clip(`task ${task} depends on ${dependency}, which is not in the plan; the dependency is dropped`));
  }

  for (const task of manifest.tasks) {
    const id = task.id;
    const spec = specs.get(id);
    const current = state.tasks[id as TaskId];
    if (current === undefined) {
      out.added.push(id);
      out.tasks.push({ id, ...(spec ?? { depends_on: [], write: [], create: [] }) });
      continue;
    }
    if (spec === undefined || !changeable(current, replanTaskId)) continue;
    const revived = current.state === "ABANDONED" && current.dropped === true;
    const same =
      sameList(current.depends_on ?? [], spec.depends_on) &&
      sameList(current.write ?? [], spec.write) &&
      sameList(current.create ?? [], spec.create);
    if (revived || !same) {
      out.changed.push(id);
      out.tasks.push({ id, ...spec });
    }
  }

  for (const current of Object.values(state.tasks)) {
    if (planIds.has(current.id)) continue;
    if (current.state === "PENDING" || current.state === "READY") out.dropped.push(current.id);
  }

  out.added.sort((a, b) => a.localeCompare(b));
  out.changed.sort((a, b) => a.localeCompare(b));
  out.dropped.sort((a, b) => a.localeCompare(b));
  out.tasks.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * The dependencies the run directory's manifest gives a task, with the names that are not in the plan dropped. Undefined
 * when the manifest or the task's spec cannot be read. A replan uses it to decide whether the task may start.
 */
export function plannedDependencies(runDir: string, taskId: string): string[] | undefined {
  const manifestPath = path.join(runDir, MANIFEST_FILE);
  try {
    const manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
    const entry = manifest.tasks.find((t) => t.id === taskId);
    if (!entry) return undefined;
    const ids = new Set(manifest.tasks.map((t) => t.id));
    const spec = parseTaskSpec(fs.readFileSync(path.resolve(runDir, entry.spec), "utf8"), entry.spec);
    return (spec.frontmatter.depends_on ?? []).filter((dep) => ids.has(dep));
  } catch {
    return undefined;
  }
}
