import type { EngineEvent } from "../contracts/index.js";
import { reduce, type EngineState } from "./reducer.js";

/**
 * The run's live journal (R8.3). `state` is the reduced state of every event appended so far and
 * `seq` the sequence number of the last one. Every event is appended and reduced at the moment it
 * is emitted, in one synchronous step, so concurrent worker actions can never give two events the
 * same sequence number, and the reduced state always equals the replay of the log. `tokens` is the
 * run's input plus output token total, the figure the run token budget is checked against.
 */
export interface RunJournal {
  state: EngineState;
  seq: number;
  tokens: number;
}

/** Reduces one event into a state. A `run.finished` also sets the terminal state its exit code names. */
export function applyJournalEvent(state: EngineState, evt: EngineEvent): EngineState {
  // R10.5: the reducer sets the terminal state of run.finished (FINISHED, PLANNED or FAILED), so live and replay agree.
  return reduce(state, evt);
}

/** The input plus output tokens a `usage.recorded` event adds to the run total (0 for other events). */
export function usageTokensOf(evt: EngineEvent): number {
  if (evt.type !== "usage.recorded") return 0;
  const record = ((evt.data ?? {}) as { record?: { input_tokens?: number; output_tokens?: number } }).record ?? {};
  return (record.input_tokens ?? 0) + (record.output_tokens ?? 0);
}
