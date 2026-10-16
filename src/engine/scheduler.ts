import type { Settings, TaskId } from "../contracts/index.js";
import { matchGlob } from "../util/index.js";
import type { EngineState } from "./reducer.js";

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
        for (const p2 of patterns2) {
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

  return readyTasks.slice(0, availableSlots);
}
