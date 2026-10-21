import fs from "node:fs";
import path from "node:path";

import type { EngineEvent } from "../contracts/index.js";
import { getTaskBranch, sweepRunWorkspaces } from "../git/index.js";
import { withRepoLock } from "../git/repo-lock.js";
import { EventStoreImpl } from "../store/event-store.js";
import { log } from "../util/log.js";
import type { EffectContext } from "./effects.js";
import { applyJournalEvent } from "./journal.js";
import type { EngineState } from "./reducer.js";

/** The failure_class a run carries when an unexpected exception ended it (known issue 45). */
export const INTERNAL_ERROR = "internal_error";

/** The error text, with the stack kept out of it: the stack goes to error.txt. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An abort or an interrupt keeps its own exit path (130 or 143), so it is not an internal error. */
export function isInterruption(error: unknown): boolean {
  const err = error as { name?: unknown; message?: unknown } | null;
  if (err?.name === "AbortError") return true;
  return typeof err?.message === "string" && (err.message.includes("SIGINT") || err.message.includes("SIGTERM"));
}

/**
 * True when the run observer threw (emit.ts): the run then stops as a dead process would, with
 * nothing further written, so the error is the caller's and is not recorded as an internal error.
 */
export function observerCrashed(ctx: EffectContext): boolean {
  return (ctx as { _observabilityCrashed?: boolean })._observabilityCrashed === true;
}

/**
 * Hands an event the engine writes itself (run.created, plan.resumed, task.ready) to the observer.
 * An observer that throws is marked crashed, the same as an event the emitter delivers (emit.ts).
 */
export function notifyObserver(ctx: EffectContext, evt: EngineEvent): void {
  try {
    ctx.onEvent?.(evt);
  } catch (err) {
    (ctx as { _observabilityCrashed?: boolean })._observabilityCrashed = true;
    throw err;
  }
}

/**
 * Ends a run that an unexpected exception stopped (R9.1, known issue 45). The stack goes to
 * error.txt in the run directory. The run is recorded as failed with a run.finished event that
 * carries failure_class internal_error and the message, so the summary, the json and the event log
 * all say the same. The task worktrees and branches are swept as for any failed run; the work of
 * every task that did not merge is kept under packets/. A run that already reached a terminal state
 * keeps it: only the stack is recorded then.
 */
export async function failRunOnInternalError(
  ctx: EffectContext,
  fallback: EngineState | undefined,
  error: unknown
): Promise<EngineState> {
  const runDir = ctx.runDir;
  try {
    fs.mkdirSync(runDir, { recursive: true });
    const stack = error instanceof Error && error.stack ? error.stack : messageOf(error);
    fs.writeFileSync(path.join(runDir, "error.txt"), `${stack}\n`, "utf8");
  } catch (writeErr: any) {
    log.warn(`could not write error.txt: ${writeErr?.message ?? String(writeErr)}`);
  }

  const state = ctx.journal?.state ?? fallback;
  if (state === undefined) {
    throw error;
  }
  if (state.state === "FINISHED" || state.state === "FAILED" || state.state === "CANCELLED") {
    log.warn(`an internal error came after the run ended ${state.state}: ${messageOf(error)}`);
    return state;
  }

  const store = ctx.store ?? new EventStoreImpl(ctx.runId, { runDir });
  const existing = store.readAllSync();
  const seq = existing.length > 0 ? existing[existing.length - 1].seq + 1 : 1;
  const evt: EngineEvent = {
    v: 1,
    seq,
    ts: new Date().toISOString(),
    run_id: ctx.runId,
    type: "run.finished",
    data: {
      exit_code: 1,
      status: "failed",
      reason: INTERNAL_ERROR,
      failure_class: INTERNAL_ERROR,
      message: messageOf(error),
    },
  };
  await store.append(evt);
  ctx.onEvent?.(evt);
  const failed = applyJournalEvent(state, evt);
  if (ctx.journal) {
    ctx.journal.state = failed;
    ctx.journal.seq = seq;
  }

  const unmerged = new Map<string, string | undefined>();
  for (const task of Object.values(failed.tasks)) {
    if (task.state === "MERGED") continue;
    const generation = task.generation ?? 1;
    unmerged.set(`${task.id}-g${generation}`, getTaskBranch(ctx.runId, task.id, generation));
  }
  try {
    await withRepoLock(ctx.repoRoot, () => sweepRunWorkspaces(ctx.repoRoot, ctx.runId, runDir, unmerged));
  } catch (sweepErr: any) {
    log.warn(`failed to remove the run's worktrees and task branches: ${sweepErr?.message ?? String(sweepErr)}`);
  }
  return failed;
}
