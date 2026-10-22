// A read-model module that writes to the console: the purity rule P2 covers src/observe.
export function announce(runId: string): string {
  console.log(`run ${runId}`);
  return runId;
}
