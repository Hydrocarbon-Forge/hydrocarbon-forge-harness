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

export function estimateRunCost(
  manifest: Manifest,
  ledger: LedgerEntry[],
  settings: Settings
): { estimated_usd: number; requires_approval: boolean } {
  const retryFactor = 0.2;
  const retryMultiplier = 1.0 + retryFactor;
  const defaultTaskBudget = settings.budgets.task.max_usd ?? 0.5;

  let totalCost = 0;
  for (const _task of manifest.tasks) {
    const targetClass = "feature";
    const classCosts = ledger
      .filter((e) => (e.task_class === targetClass || !e.task_class) && e.usage?.cost_usd != null)
      .map((e) => e.usage.cost_usd);

    let baseCost: number;
    if (classCosts.length > 0) {
      baseCost = calculateMedian(classCosts);
    } else {
      const allCosts = ledger
        .filter((e) => e.usage?.cost_usd != null)
        .map((e) => e.usage.cost_usd);
      baseCost = allCosts.length > 0 ? calculateMedian(allCosts) : defaultTaskBudget;
    }

    totalCost += baseCost * retryMultiplier;
  }

  const approvalThreshold = settings.budgets.approval_threshold_usd ?? 2.0;
  const requires_approval = totalCost > approvalThreshold;

  return {
    estimated_usd: totalCost,
    requires_approval,
  };
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
