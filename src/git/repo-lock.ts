// R8.3: one async mutex per repository for the git operations that change shared repository
// metadata: worktree add and remove, task branch create, merges into the run branch through the
// integration worktree, and the cleanup sweep. Callers queue in call order, so two such operations
// never run at the same time on one repository (git lock contention). The worker processes and
// their verify commands run outside it, in their own worktrees.

const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` once every operation queued before it on the same repository has settled. A failing
 * operation does not block the ones queued after it. Returns the value or rejection of `fn`.
 */
export function withRepoLock<T>(repoRoot: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = tails.get(repoRoot) ?? Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(repoRoot, tail);
  void tail.then(() => {
    if (tails.get(repoRoot) === tail) tails.delete(repoRoot);
  });
  return run;
}
