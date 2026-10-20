import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Engine,
  EngineEvent,
  HarnessAdapter,
  RunId,
  RunOptions,
  RunSummary,
  TaskId,
} from "../../../src/contracts/index.js";
import { createEngine } from "../../../src/engine/engine.js";
import { reduce, type EngineState } from "../../../src/engine/reducer.js";
import { FakeAdapter } from "../../conformance/fake-adapter.js";

export interface ChaosRunResult {
  runId: RunId;
  interruptedAtSeq: number;
  interruptedEvent: EngineEvent;
  resumedSummary: RunSummary;
  totalEventsBefore: number;
  totalEventsAfter: number;
}

export interface ChaosHarnessOptions {
  repoRoot: string;
  runId: RunId;
  killAtSeq?: number;
  corruptTail?: boolean;
  corruptContent?: string;
  simulateActiveLock?: boolean;
}

export class SimulatedCrashError extends Error {
  constructor(public readonly seq: number, public readonly event?: EngineEvent) {
    super(`Simulated ungraceful crash at event sequence ${seq}${event ? ` (${event.type})` : ""}`);
    this.name = "SimulatedCrashError";
  }
}

export async function runUntilBoundaryAndCrash(
  opts: RunOptions & { adapter?: HarnessAdapter; engine?: Engine },
  boundarySeq: number
): Promise<{ crashedSeq: number; runDir: string }> {
  let crashedSeq = 0;
  let runDir = "";

  const originalOnEvent = opts.onEvent;
  const customEngine = opts.engine ?? createEngine({ adapter: opts.adapter ?? new FakeAdapter() });

  const instrumentedOpts: RunOptions = {
    ...opts,
    onEvent: (evt: EngineEvent) => {
      originalOnEvent?.(evt);
      runDir = join(opts.cwd, ".substrate", "runs", evt.run_id);
      if (evt.seq === boundarySeq) {
        crashedSeq = evt.seq;
        throw new SimulatedCrashError(evt.seq, evt);
      }
    },
  };

  try {
    await customEngine.run(instrumentedOpts);
  } catch (err: any) {
    if (err instanceof SimulatedCrashError || err?.name === "SimulatedCrashError") {
      return { crashedSeq, runDir };
    }
    throw err;
  }

  return { crashedSeq, runDir };
}

export function recoverInFlightRun(runDir: string, repoRoot: string): void {
  const eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) return;

  const content = readFileSync(eventsPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: EngineEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  if (events.length === 0) return;

  const lastEvent = events[events.length - 1];
  if (lastEvent.type === "run.finished") return;

  let state: EngineState = {
    run_id: lastEvent.run_id,
    state: "CREATED",
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
  for (const ev of events) {
    state = reduce(state, ev);
  }

  let nextSeq = events[events.length - 1].seq + 1;

  // Only tasks already in the replayed state can be VERIFYING or SCOPE_CHECK, so the
  // state's task ids are the ones step 1 needs.
  const allTaskIds = Object.keys(state.tasks) as TaskId[];

  if (state.state === "EXECUTING") {
    // 1. Crash immediately after writing task.verify.finished but before task.passed:
    // advance directly to task.passed without re-running verify commands per §14.5 edge case
    for (const taskId of allTaskIds) {
      const t = state.tasks[taskId];
      if (t && (t.state === "VERIFYING" || t.state === "SCOPE_CHECK")) {
        if (
          lastEvent.type === "task.verify.finished" &&
          (lastEvent.data as any)?.task_id === taskId &&
          (lastEvent.data as any)?.passed === true
        ) {
          const passEvt: EngineEvent = {
            v: 1,
            seq: nextSeq++,
            ts: new Date().toISOString(),
            run_id: state.run_id,
            type: "task.passed",
            data: {
              task_id: taskId,
              generation: t.generation ?? 1,
              attempt: t.attempt ?? 1,
            },
          };
          appendFileSync(eventsPath, JSON.stringify(passEvt) + "\n", "utf8");
          state = reduce(state, passEvt);
        }
      }
    }

    // Steps removed (R6.3): the helper used to append batch.started and task.ready for
    // PENDING and in-flight tasks here. The engine's resume writes task.ready for RUNNING,
    // SCOPE_CHECK and VERIFYING tasks itself (engine.ts resume), and the scheduler releases
    // PENDING roots (unreleasedRootTasks, effects.ts). The chaos scenarios now run that path.
  }
}

export async function resumeAfterCrash(
  runId: RunId,
  opts?: Partial<RunOptions> & { adapter?: HarnessAdapter; engine?: Engine }
): Promise<RunSummary> {
  const repoRoot = opts?.cwd ?? process.cwd();
  const runDir = join(repoRoot, ".substrate", "runs", runId);

  // Clean up any stale git lock files left by interrupted git commands per §14.5 edge case
  const gitIndexLock = join(repoRoot, ".git", "index.lock");
  if (existsSync(gitIndexLock)) {
    try {
      unlinkSync(gitIndexLock);
    } catch {}
  }

  recoverInFlightRun(runDir, repoRoot);

  const engine = opts?.engine ?? createEngine({ adapter: opts?.adapter ?? new FakeAdapter() });
  return await engine.resume(runId, opts);
}

export function corruptEventLogTail(
  runDir: string,
  corruptionType: "truncated_json" | "garbage_bytes"
): void {
  const eventsPath = join(runDir, "events.jsonl");
  const content = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const nextSeq = lines.length + 1;
  const corruptContent =
    corruptionType === "truncated_json"
      ? `{"v":1,"seq":${nextSeq},"type":"task.`
      : "GARBAGE_BYTES_\x00\xFF\xFE\xFD_CORRUPT_TAIL";
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  appendFileSync(eventsPath, prefix + corruptContent + "\n", "utf8");
}

export function createSimulatedLock(
  repoRoot: string,
  runId: RunId,
  opts: { pid: number; heartbeatAgeMs: number }
): string {
  const stateDir = join(repoRoot, ".substrate", "state");
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, `${runId}.lock`);
  const heartbeatTime = new Date(Date.now() - opts.heartbeatAgeMs).toISOString();
  const lockData = {
    pid: opts.pid,
    run_id: runId,
    acquired_at: heartbeatTime,
    heartbeat_at: heartbeatTime,
  };
  writeFileSync(lockPath, JSON.stringify(lockData), "utf8");
  return lockPath;
}
