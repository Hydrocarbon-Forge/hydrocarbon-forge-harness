import { parseEngineEvent } from "../contracts/events.js";
import type { EngineEvent } from "../contracts/index.js";
import { commitEvent, type EffectContext } from "./effects.js";
import type { EngineState } from "./reducer.js";
import type { RunJournal } from "./journal.js";
import { EVENT_TYPES, type EventData, type EventType } from "../contracts/events.js";

/**
 * Typed emit: validates the event against the catalog before it is pushed,
 * appended to the run log, or delivered to the observer.
 */
export function typedEmit(
  opts: {
    events: EngineEvent[];
    getSeq: () => number;
    write: (evt: EngineEvent) => void;
    onEvent?: (evt: EngineEvent) => void;
  },
  runId: string,
  type: never,
  data: never
): EngineEvent;
export function typedEmit<T extends EventType>(
  opts: {
    events: EngineEvent[];
    getSeq: () => number;
    write: (evt: EngineEvent) => void;
    onEvent?: (evt: EngineEvent) => void;
  },
  runId: string,
  type: T,
  data: EventData<T>,
): EngineEvent;
export function typedEmit<T extends EventType>(
  opts: {
    events: EngineEvent[];
    getSeq: () => number;
    write: (evt: EngineEvent) => void;
    onEvent?: (evt: EngineEvent) => void;
  },
  runId: string,
  type: T,
  data: unknown,
): EngineEvent {
  const evt: EngineEvent = {
    v: 1,
    seq: opts.getSeq(),
    ts: new Date().toISOString(),
    run_id: runId,
    type: type,
    data,
  } as EngineEvent;
  // Throws a ZodError naming the type when the event is not in the catalog,
  // or its data does not match the member's shape.
  parseEngineEvent(evt);
  opts.events.push(evt);
  opts.write(evt);
  if (opts.onEvent) {
    opts.onEvent(evt);
  }
  return evt;
}

/**
 * Creates a fresh emitter for one action execution. Every event is persisted to
 * the run log and delivered to the observer as it is emitted, so callers
 * observing the run directory (and stream consumers) see events while long
 * actions are still running. If the observer throws, the run has crashed from
 * its perspective: like a dead process, nothing further is written; execution
 * continues unobserved.
 */
export function makeEmitter(
  ctx: EffectContext,
  state: EngineState
): { events: EngineEvent[]; emit: TypedEmit } {
  const events: EngineEvent[] = [];
  // R8.3: the sequence number is the run journal's, not this action's, so two actions running at
  // once cannot number their events the same. The event is numbered, checked against the catalog,
  // and committed (appended and reduced) in one synchronous step.
  // A context without a journal (an action run outside the loop) gets one from the state it is given.
  ctx.journal ??= { state, seq: (state as any)._seq ?? 0, tokens: 0 };
  const journal: RunJournal = ctx.journal;

  const emit = <T extends EventType>(
    type: T,
    data: EventData<T>
  ): EngineEvent => {
    const crashed = Boolean((ctx as any)._observabilityCrashed);
    return typedEmit(
      {
        events,
        getSeq: () => journal.seq + 1,
        write: (evt) => {
          commitEvent(ctx, journal, evt, !crashed);
        },
        onEvent: ctx.onEvent && !crashed
          ? (evt) => {
              try {
                ctx.onEvent?.(evt);
              } catch (err) {
                (ctx as any)._observabilityCrashed = true;
                throw err;
              }
            }
          : undefined,
      },
      ctx.runId,
      type,
      data,
    );
  };

  return { events, emit };
}

export type TypedEmit = <T extends EventType>(
  type: T,
  data: EventData<T>
) => EngineEvent;
