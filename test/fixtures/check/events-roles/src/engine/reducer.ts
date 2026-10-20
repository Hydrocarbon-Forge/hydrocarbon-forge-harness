export function reduce(type: string): number {
  switch (type) {
    // Emitted only by src/roles/worker.ts: must NOT be reported.
    case "task.emitted.fromrole":
      return 1;
    // Consumed but emitted nowhere: must be reported.
    case "task.never.emitted":
      return 2;
  }
  return 0;
}
