import type { Settings, TaskId } from "../contracts/index.js";
import { matchGlob } from "../util/index.js";
import type { EngineState, TaskRuntimeState } from "./reducer.js";

function patternsOverlap(p1: string, p2: string): boolean {
  if (p1 === p2) return true;
  return matchGlob(p1, p2) || matchGlob(p2, p1);
}

export function detectOverlap(
  tasks: { id: TaskId; write: string[]; create: string[] }[]
): Map<TaskId, Set<TaskId>> {
  const overlaps = new Map<TaskId, Set<TaskId>>();

  for (const t of tasks) {
    overlaps.set(t.id, new Set<TaskId>());
  }

  for (let i = 0; i < tasks.length; i++) {
    const t1 = tasks[i];
    const patterns1 = [...t1.write, ...t1.create];

    for (let j = i + 1; j < tasks.length; j++) {
      const t2 = tasks[j];
      const patterns2 = [...t2.write, ...t2.create];

      let hasOverlap = false;
      for (const p1 of patterns1) {
        for (let p2 of patterns2) {
          if (patternsOverlap(p1, p2)) {
            hasOverlap = true;
            break;
          }
        }
        if (hasOverlap) break;
      }

      if (hasOverlap) {
        overlaps.get(t1.id)!.add(t2.id);
        overlaps.get(t2.id)!.add(t1.id);
      }
    }
  }

  return overlaps;
}

/**
 * PENDING tasks whose every dependency is MERGED. A dependent worktree is
 * created from the run branch, so it can only see a dependency's changes after
 * that dependency has been merged. Pure: it reports what would change, it does
 * not change the state.
 */
export function promoteReadyTasks(state: EngineState): TaskId[] {
  const ready: TaskId[] = [];

  for (const task of Object.values(state.tasks)) {
    if (task.state !== "PENDING") continue;
    const deps = task.depends_on ?? [];
    if (deps.length === 0) continue;
    if (deps.every((dep) => state.tasks[dep]?.state === "MERGED")) {
      ready.push(task.id);
    }
  }

  return ready.sort((a, b) => a.localeCompare(b));
}

/**
 * PENDING tasks with no dependencies. Setup emits `task.ready` for these as the
 * first batch; a log cut between `setup.done` and that event leaves them PENDING,
 * so a resume has to release them. Pure, like promoteReadyTasks.
 */
export function unreleasedRootTasks(state: EngineState): TaskId[] {
  return Object.values(state.tasks)
    .filter((t) => t.state === "PENDING" && (t.depends_on ?? []).length === 0)
    .map((t) => t.id)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * PENDING tasks that have a dependency in BLOCKED or ABANDONED. They become
 * BLOCKED through a `task.blocked` event, so the state change is still an
 * appended event. Pure, like promoteReadyTasks.
 */
export function blockedPendingTasks(state: EngineState): TaskId[] {
  const blocked: TaskId[] = [];

  for (const task of Object.values(state.tasks)) {
    if (task.state !== "PENDING") continue;
    const hasBlockedDep = (task.depends_on ?? []).some((dep) => {
      const depState = state.tasks[dep]?.state;
      return depState === "BLOCKED" || depState === "ABANDONED";
    });
    if (hasBlockedDep) {
      blocked.push(task.id);
    }
  }

  return blocked.sort((a, b) => a.localeCompare(b));
}

/** Tasks whose work is in flight: they hold a worktree and a session. */
function inFlightTasks(state: EngineState): TaskRuntimeState[] {
  return Object.values(state.tasks).filter(
    (t) => t.state === "RUNNING" || t.state === "SCOPE_CHECK" || t.state === "VERIFYING"
  );
}

/**
 * The backend a task is routed to. `nextActions` keeps its signature and the
 * state carries no per-task route, so this is the configured worker route.
 */
function workerBackend(settings: Settings): string | undefined {
  return settings.roles?.worker?.backend;
}

export function scheduleNextTasks(
  state: EngineState,
  settings: Settings,
  activeCount: number
): TaskId[] {
  if (
    state.state === "PAUSED" ||
    state.state === "FINISHED" ||
    state.state === "FAILED" ||
    state.state === "CANCELLED"
  ) {
    return [];
  }

  const maxUsd = settings.budgets.run.max_usd;
  if (maxUsd !== undefined && state.usage.total_usd >= maxUsd) {
    return [];
  }

  const availableSlots = settings.concurrency.workers - activeCount;
  if (availableSlots <= 0) {
    return [];
  }

  const readyTasks = Object.values(state.tasks)
    .filter((t) => t.state === "READY")
    .map((t) => t.id)
    .sort();

  if (readyTasks.length === 0) {
    return [];
  }

  const inFlight = inFlightTasks(state);
  const overlaps = detectOverlap([
    ...inFlight.map((t) => ({ id: t.id, write: t.write ?? [], create: t.create ?? [] })),
    ...readyTasks.map((id) => {
      const task = state.tasks[id];
      return { id, write: task?.write ?? [], create: task?.create ?? [] };
    }),
  ]);

  const backend = workerBackend(settings);
  const cap = backend !== undefined ? settings.backends[backend]?.max_concurrency : undefined;
  const inFlightOnBackend = inFlight.length;

  const picked: TaskId[] = [];
  for (const taskId of readyTasks) {
    if (picked.length >= availableSlots) break;

    const overlapsInFlight = inFlight.some(
      (t) => overlaps.get(taskId)?.has(t.id) === true
    );
    if (overlapsInFlight) continue;

    if (cap !== undefined && inFlightOnBackend + picked.length >= cap) continue;

    picked.push(taskId);
  }

  return picked;
}
