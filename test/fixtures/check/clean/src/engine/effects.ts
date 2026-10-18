function emit(type: string, data?: unknown) {}

export function run() {
  emit("task.started", {});
}
