import type { HarnessAdapter, SessionHandle, SpawnRequest } from "../contracts/index.js";
import { HarnessSpawnError } from "./process.js";

// A harness process that cannot start at all (no output exists yet) is retried inside the same attempt.
// The waits before the second and third tries; after the last one the spawn fails for good.
export const SPAWN_RETRY_DELAYS_MS = [2000, 5000];

// Only these start failures are transient. A missing binary (ENOENT) or a refused one (EACCES) never
// gets better by waiting, so it fails at once. E2BIG is not retried either: prompts go over stdin (R13.1).
const TRANSIENT_SPAWN_CODES = new Set(["EAGAIN", "EMFILE", "ENOMEM"]);

/**
 * Starts one harness session through the adapter. Every planner, worker and replan spawn goes through
 * here, so the retry lives in one place. A transient start failure (HarnessSpawnError with no code or a
 * transient code) is retried with the delays above and never touches the heal or replan counters; any
 * other error is rethrown at once. When every try fails, the error names the spawn failure in plain words.
 */
export async function startHarnessSession(adapter: HarnessAdapter, req: SpawnRequest): Promise<SessionHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      return adapter.spawn(req);
    } catch (err) {
      if (!(err instanceof HarnessSpawnError)) throw err;
      if (err.code !== undefined && !TRANSIENT_SPAWN_CODES.has(err.code)) throw err;
      const delayMs = SPAWN_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        throw new HarnessSpawnError(
          `${err.message} (failed ${attempt + 1} times in a row; the harness did not start)`,
          err.code,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
