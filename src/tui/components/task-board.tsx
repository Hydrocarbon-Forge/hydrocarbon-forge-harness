import type { TaskId } from "../../contracts/index.js";
/* intra-tui */ import type { TaskItemState } from "../state/types.js";

export interface TaskBoardProps {
  tasks: Record<TaskId, TaskItemState>;
  visible: boolean;
}

export function formatTaskStatus(task: TaskItemState): string {
  const failure = task.failureClass ? ` (${task.failureClass})` : "";
  return `[${task.state}] Task ${task.id} (gen ${task.generation})${failure}`;
}

export function formatTaskBoard(tasks: Record<TaskId, TaskItemState>): string[] {
  const list = Object.values(tasks);
  if (list.length === 0) {
    return ["Task Board: No active tasks."];
  }
  const lines = ["Task Board:"];
  for (const t of list) {
    lines.push(`  ${formatTaskStatus(t)}`);
  }
  return lines;
}

export function TaskBoard(props: TaskBoardProps): string[] {
  if (!props.visible) {
    return [];
  }
  return formatTaskBoard(props.tasks);
}
