import type {
  BackendName,
  Manifest,
  RoleName,
  RunId,
  Settings,
  TaskClass,
  TaskId,
  UsageRecord,
} from "../contracts/index.js";

export interface LedgerEntry {
  run_id: RunId;
  task_id?: TaskId;
  role: RoleName;
  backend: BackendName;
  model: string;
  task_class?: TaskClass;
  generation?: number;
  attempt?: number;
  usage: UsageRecord;
}

export interface CostSummary {
  total_usd: number;
  by_role: Record<string, number>;
  by_class: Record<string, number>;
  by_tier: Record<string, number>;
}

function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The base cost of a task the estimate has no evidence for: no spec budget and no ledger entry. It is
 * only an estimate for the approval threshold and the plan summary; it never caps a task (owner, 2026-10-21).
 */
export const ESTIMATE_TASK_USD = 0.5;

/**
 * The estimated cost of a plan, reported with the plan (owner, 2026-10-23: advisory only, it gates nothing). A
 * task's spec budget (an advisory figure the planner wrote) is its base cost when the spec has one; otherwise the
 * median of the ledger's costs for the class, then for all tasks, then ESTIMATE_TASK_USD. Each task gets a retry
 * allowance.
 */
export function estimateRunCost(
  manifest: Manifest,
  ledger: LedgerEntry[],
  specs?: ReadonlyMap<TaskId, { frontmatter?: { budget?: { max_usd?: number } } }>
): { estimated_usd: number } {
  const retryFactor = 0.2;
  const retryMultiplier = 1.0 + retryFactor;

  let totalCost = 0;
  for (const task of manifest.tasks) {
    const specBudget = specs?.get(task.id)?.frontmatter?.budget?.max_usd;
    const targetClass = "feature";
    const classCosts = ledger
      .filter((e) => (e.task_class === targetClass || !e.task_class) && e.usage?.cost_usd != null)
      .map((e) => e.usage.cost_usd);

    let baseCost: number;
    if (specBudget !== undefined) {
      baseCost = specBudget;
    } else if (classCosts.length > 0) {
      baseCost = calculateMedian(classCosts);
    } else {
      const allCosts = ledger
        .filter((e) => e.usage?.cost_usd != null)
        .map((e) => e.usage.cost_usd);
      baseCost = allCosts.length > 0 ? calculateMedian(allCosts) : ESTIMATE_TASK_USD;
    }

    totalCost += baseCost * retryMultiplier;
  }

  return { estimated_usd: totalCost };
}

export function aggregateLedger(
  entries: LedgerEntry[]
): CostSummary & {
  first_pass_rate: number;
  heal_rate: number;
  replans_per_task: Record<TaskId, number>;
} {
  let total_usd = 0;
  const by_role: Record<string, number> = {};
  const by_class: Record<string, number> = {};
  const by_tier: Record<string, number> = {};

  for (const entry of entries) {
    const cost = entry.usage?.cost_usd ?? 0;
    total_usd += cost;
    if (entry.role) {
      by_role[entry.role] = (by_role[entry.role] ?? 0) + cost;
    }
    if (entry.task_class) {
      by_class[entry.task_class] = (by_class[entry.task_class] ?? 0) + cost;
    }
    if (entry.model) {
      by_tier[entry.model] = (by_tier[entry.model] ?? 0) + cost;
    }
  }

  const tasksMap = new Map<TaskId, LedgerEntry[]>();
  for (const entry of entries) {
    if (entry.task_id) {
      let list = tasksMap.get(entry.task_id);
      if (!list) {
        list = [];
        tasksMap.set(entry.task_id, list);
      }
      list.push(entry);
    }
  }

  let firstPassCount = 0;
  let healCount = 0;
  const replans_per_task: Record<TaskId, number> = {};

  for (const [taskId, tEntries] of tasksMap.entries()) {
    let maxGen = 1;
    let maxAttempt = 1;
    for (const e of tEntries) {
      if (e.generation !== undefined && e.generation > maxGen) {
        maxGen = e.generation;
      }
      if (e.attempt !== undefined && e.attempt > maxAttempt) {
        maxAttempt = e.attempt;
      }
    }

    const replans = Math.max(0, maxGen - 1);
    if (replans > 0) {
      replans_per_task[taskId] = replans;
    }

    if (maxGen === 1 && maxAttempt === 1) {
      firstPassCount++;
    } else if (maxGen === 1 && maxAttempt > 1) {
      healCount++;
    }
  }

  const totalTasks = tasksMap.size;
  const first_pass_rate = totalTasks > 0 ? firstPassCount / totalTasks : 0;
  const heal_rate = totalTasks > 0 ? healCount / totalTasks : 0;

  return {
    total_usd,
    by_role,
    by_class,
    by_tier,
    first_pass_rate,
    heal_rate,
    replans_per_task,
  };
}
