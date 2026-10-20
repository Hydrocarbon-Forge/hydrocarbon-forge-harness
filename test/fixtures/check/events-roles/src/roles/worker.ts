export interface WorkerOpts {
  onEvent?: (type: string, data?: unknown) => void;
}

export function runWorker(opts: WorkerOpts) {
  // Emitted from a role through the optional onEvent callback (call shape used in src/roles).
  opts.onEvent?.("task.emitted.fromrole", {});
}
