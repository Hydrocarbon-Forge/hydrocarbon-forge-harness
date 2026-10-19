import type {
  EngineEvent,
  FailureClass,
  PauseReason,
  RunId,
  SessionId,
  TaskId,
} from "../contracts/index.js";

export type RunState =
  | "CREATED"
  | "ROUTING"
  | "PLANNING"
  | "LINTING"
  | "AWAITING_APPROVAL"
  | "SETUP"
  | "EXECUTING"
  | "INTEGRATING"
  | "REVIEWING"
  | "FINISHED"
  | "PAUSED"
  | "FAILED"
  | "CANCELLED";

export type TaskState =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "SCOPE_CHECK"
  | "VERIFYING"
  | "HEALING"
  | "PASSED"
  | "MERGING"
  | "MERGED"
  | "FAILED"
  | "REPLANNING"
  | "BLOCKED"
  | "ABANDONED";

export interface TaskRuntimeState {
  id: TaskId;
  state: TaskState;
  generation: number;
  attempt: number;
  session_id?: SessionId;
  failure_class?: FailureClass;
  depends_on?: TaskId[];
  write?: string[];
  create?: string[];
}

declare module "../contracts/index.js" {
  export type RunState =
    | "CREATED"
    | "ROUTING"
    | "PLANNING"
    | "LINTING"
    | "AWAITING_APPROVAL"
    | "SETUP"
    | "EXECUTING"
    | "INTEGRATING"
    | "REVIEWING"
    | "FINISHED"
    | "PAUSED"
    | "FAILED"
    | "CANCELLED";

  export type TaskState =
    | "PENDING"
    | "READY"
    | "RUNNING"
    | "SCOPE_CHECK"
    | "VERIFYING"
    | "HEALING"
    | "PASSED"
    | "MERGING"
    | "MERGED"
    | "FAILED"
    | "REPLANNING"
    | "BLOCKED"
    | "ABANDONED";

  export interface TaskRuntimeState {
    id: TaskId;
    state: TaskState;
    generation: number;
    attempt: number;
    session_id?: SessionId;
    failure_class?: FailureClass;
    depends_on?: TaskId[];
    write?: string[];
    create?: string[];
  }
}

export interface EngineState {
  run_id: RunId;
  state: RunState;
  pause_reason?: PauseReason;
  prior_state?: RunState;
  tasks: Record<TaskId, TaskRuntimeState>;
  usage: { total_usd: number; by_role: Record<string, number> };
  checkpoints: string[];
}

export function reduce(state: EngineState, event: EngineEvent): EngineState {
  const data = (event.data ?? {}) as Record<string, any>;

  switch (event.type) {
    case "run.created": {
      return {
        run_id: data.run_id ?? event.run_id ?? state.run_id,
        state: "CREATED",
        tasks: {},
        usage: { total_usd: 0, by_role: {} },
        checkpoints: [],
      };
    }

    case "run.routed": {
      return {
        ...state,
        state: "PLANNING",
      };
    }

    case "plan.produced": {
      const nextTasks = { ...state.tasks };
      const taskList = data.tasks ?? data.manifest?.tasks;
      if (Array.isArray(taskList)) {
        for (const t of taskList) {
          if (t && t.id && !nextTasks[t.id]) {
            nextTasks[t.id] = {
              id: t.id,
              state: "PENDING",
              generation: 1,
              attempt: 1,
            };
          }
        }
      }
      return {
        ...state,
        state: "LINTING",
        tasks: nextTasks,
      };
    }

    case "plan.lint": {
      if (data.requires_approval === true) {
        return { ...state, state: "AWAITING_APPROVAL" };
      } else if (data.requires_approval === false) {
        return { ...state, state: "SETUP" };
      }
      return state;
    }

    case "tasks.invalidated": {
      const ids = Array.isArray(data.task_ids) ? data.task_ids : [];
      const nextTasks = { ...state.tasks };
      for (const id of ids) {
        if (nextTasks[id]) {
          nextTasks[id] = { ...nextTasks[id], state: "READY" };
        }
      }
      return { ...state, tasks: nextTasks };
    }

    case "integration.failed": {
      return {
        ...state,
        state: "FAILED",
        tasks: Object.fromEntries(
          Object.entries(state.tasks).map(([id, t]) => [
            id,
            t.state === "RUNNING" ||
            t.state === "VERIFYING" ||
            t.state === "SCOPE_CHECK" ||
            t.state === "MERGING"
              ? { ...t, state: "FAILED" }
              : t,
          ])
        ) as typeof state.tasks,
      };
    }

    case "batch.merged": {
      const ref = data.checkpoint_ref;
      return {
        ...state,
        checkpoints: ref ? [...state.checkpoints, ref] : state.checkpoints,
      };
    }

    case "plan.approved": {
      return {
        ...state,
        state: "SETUP",
      };
    }

    case "plan.rejected": {
      return {
        ...state,
        state: "CANCELLED",
      };
    }

    case "setup.done": {
      const nextTasks = { ...state.tasks };
      const taskList = Array.isArray(data.tasks) ? data.tasks : [];
      for (const t of taskList) {
        if (!t?.id) continue;
        const current =
          nextTasks[t.id] ?? { id: t.id, state: "PENDING", generation: 1, attempt: 1 };
        nextTasks[t.id] = {
          ...current,
          depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
          write: Array.isArray(t.write) ? t.write : [],
          create: Array.isArray(t.create) ? t.create : [],
        };
      }

      return {
        ...state,
        state: "EXECUTING",
        tasks: nextTasks,
      };
    }

    case "task.ready": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId];
      const updated: TaskRuntimeState = current
        ? { ...current, state: "READY" }
        : { id: taskId, state: "READY", generation: 1, attempt: 1 };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "task.session.started": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      const updated: TaskRuntimeState = {
        ...current,
        state: "RUNNING",
        session_id: data.session_id,
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "task.scope.checked": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      const updated: TaskRuntimeState = {
        ...current,
        state: "SCOPE_CHECK",
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "task.verify.started": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      const updated: TaskRuntimeState = {
        ...current,
        state: "VERIFYING",
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "task.verify.finished": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      let updated: TaskRuntimeState;
      if (data.passed) {
        updated = { ...current, state: "PASSED" };
      } else {
        if ((current.attempt ?? 1) === 1) {
          updated = {
            ...current,
            state: "HEALING",
            failure_class: data.failure_class,
          };
        } else {
          updated = {
            ...current,
            state: "FAILED",
            failure_class: data.failure_class ?? "verify_failed",
          };
        }
      }
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "task.healing": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      const updated: TaskRuntimeState = {
        ...current,
        state: "HEALING",
        attempt: (current.attempt ?? 1) + 1,
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "task.passed": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      const updated: TaskRuntimeState = {
        ...current,
        state: "MERGING",
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "task.merged": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      const updated: TaskRuntimeState = {
        ...current,
        state: "MERGED",
      };
      const nextTasks = { ...state.tasks, [taskId]: updated };

      const allTaskValues = Object.values(nextTasks) as TaskRuntimeState[];
      const allMerged = allTaskValues.length > 0 && allTaskValues.every((t) => t.state === "MERGED");
      let nextRunState = state.state;
      if (state.state === "EXECUTING" && allMerged) {
        nextRunState = "INTEGRATING";
      }
      return {
        ...state,
        state: nextRunState,
        tasks: nextTasks,
      };
    }

    case "task.failed": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      let nextState: TaskState;
      if (data.can_replan === false) {
        nextState = "BLOCKED";
      } else if (data.can_replan === true) {
        nextState = "REPLANNING";
      } else {
        const maxReplans = data.max_replans ?? 2;
        nextState = (current.generation ?? 1) <= maxReplans ? "REPLANNING" : "BLOCKED";
      }
      const updated: TaskRuntimeState = {
        ...current,
        state: nextState,
        failure_class: data.failure_class ?? current.failure_class,
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "replan.finished": {
      const taskId = data.task_id;
      if (!taskId) return state;
      const current = state.tasks[taskId] ?? { id: taskId, generation: 1, attempt: 1 };
      const updated: TaskRuntimeState = {
        ...current,
        state: "READY",
        generation: data.generation ?? (current.generation ?? 1) + 1,
        attempt: 1,
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: updated },
      };
    }

    case "bisect.culprit": {
      const culpritId = data.culprit_task_id;
      if (!culpritId || !state.tasks[culpritId]) return state;
      const current = state.tasks[culpritId];
      const updated: TaskRuntimeState = {
        ...current,
        failure_class: "integration_failed",
      };
      return {
        ...state,
        tasks: { ...state.tasks, [culpritId]: updated },
      };
    }

    case "task.blocked": {
      const nextTasks = { ...state.tasks };
      const taskId = data.task_id;
      if (taskId && nextTasks[taskId]) {
        nextTasks[taskId] = { ...nextTasks[taskId], state: "BLOCKED" };
      }
      if (Array.isArray(data.dependents)) {
        for (const depId of data.dependents) {
          if (nextTasks[depId]) {
            nextTasks[depId] = { ...nextTasks[depId], state: "BLOCKED" };
          }
        }
      }
      return {
        ...state,
        tasks: nextTasks,
      };
    }

    case "integration.finished": {
      if (data.passed) {
        return {
          ...state,
          state: data.reviewing ? "REVIEWING" : "FINISHED",
        };
      } else {
        return {
          ...state,
          state: "FAILED",
        };
      }
    }

    case "run.paused": {
      return {
        ...state,
        prior_state: state.state === "PAUSED" ? state.prior_state : state.state,
        state: "PAUSED",
        pause_reason: data.reason,
      };
    }

    case "run.resumed": {
      return {
        ...state,
        state: state.prior_state ?? "EXECUTING",
        pause_reason: undefined,
        prior_state: undefined,
      };
    }

    case "usage.recorded": {
      // Counted exactly once: the action emits only the per-report delta;
      // budget decisions live in the actions, not here.
      const record = data.record;
      const cost = record?.cost_usd ?? 0;
      const role = data.role ?? "unknown";
      const nextTotalUsd = state.usage.total_usd + cost;
      const nextByRole = {
        ...state.usage.by_role,
        [role]: (state.usage.by_role[role] ?? 0) + cost,
      };

      return {
        ...state,
        usage: {
          total_usd: nextTotalUsd,
          by_role: nextByRole,
        },
      };
    }

    default:
      return state;
  }
}

export function computeDagLayers(
  tasks: { id: TaskId; depends_on: TaskId[] }[]
): TaskId[][] {
  const allIds = new Set(tasks.map((t) => t.id));
  const inDegree = new Map<TaskId, number>();
  const adjList = new Map<TaskId, TaskId[]>();

  for (const t of tasks) {
    adjList.set(t.id, []);
    if (t.depends_on.includes(t.id)) {
      throw new Error(`Cycle detected: task ${t.id} depends on itself`);
    }
  }

  for (const t of tasks) {
    const validDeps = new Set(t.depends_on.filter((d) => allIds.has(d)));
    inDegree.set(t.id, validDeps.size);
    for (const dep of validDeps) {
      adjList.get(dep)!.push(t.id);
    }
  }

  const layers: TaskId[][] = [];
  let currentLayer: TaskId[] = [];

  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      currentLayer.push(id);
    }
  }

  let processedCount = 0;

  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    processedCount += currentLayer.length;
    const nextLayer: TaskId[] = [];

    for (const u of currentLayer) {
      for (const v of adjList.get(u)!) {
        const newDeg = (inDegree.get(v) ?? 1) - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) {
          nextLayer.push(v);
        }
      }
    }

    currentLayer = nextLayer;
  }

  if (processedCount < tasks.length) {
    throw new Error("Cycle detected in task dependencies");
  }

  return layers;
}
