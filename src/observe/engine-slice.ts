import { EventStoreImpl } from "../store/event-store.js";
import type { EngineEvent, RunId } from "../contracts/index.js";

// The engine journal of a run, sliced by seq (docs/design/web-ui.md, 5.2 GET /api/runs/:ref/engine). The journal is
// read through the event store's own reader, which tolerates a torn last line.

export interface EngineSliceOut {
  events: EngineEvent[];
  next: number;
  complete: boolean;
}

export function engineSliceOf(runDir: string, runId: string, after: number, limit: number, runIsLive: boolean): EngineSliceOut {
  const all = new EventStoreImpl(runId as RunId, { runDir }).readAllSync();
  const events = all.filter((e) => e.seq > after).slice(0, limit);
  const next = events.length > 0 ? events[events.length - 1].seq : after;
  const lastSeq = all.length > 0 ? all[all.length - 1].seq : 0;
  return { events, next, complete: !runIsLive && next >= lastSeq };
}
