import type { EngineEvent } from "../../contracts/index.js";

export interface EventFeedProps {
  events: EngineEvent[];
  verbose: boolean;
  maxLines?: number;
}

export function formatFeedEvent(event: EngineEvent, verbose: boolean): string {
  if (verbose) {
    return `[${event.ts}] (${event.type}) seq=${event.seq} data=${JSON.stringify(event.data)}`;
  }
  // Compact summary format
  if (event.type === "run.state") {
    const data = event.data as { state?: string } | undefined;
    return `-> Run state: ${data?.state ?? "unknown"}`;
  }
  if (event.type === "run.paused") {
    return "!! Run paused";
  }
  if (event.type === "run.finished") {
    return "✓ Run finished";
  }
  if (event.type.startsWith("task.")) {
    const data = event.data as { task_id?: string } | undefined;
    return `* Task ${data?.task_id ?? ""}: ${event.type.replace("task.", "")}`;
  }
  if (event.type === "usage.recorded") {
    const data = event.data as { record?: { cost_usd?: number }; cost_usd?: number } | undefined;
    const cost = data?.record?.cost_usd ?? data?.cost_usd ?? 0;
    return `$ Spend recorded: +$${cost.toFixed(4)}`;
  }
  return `[${event.type}]`;
}

export function formatEventFeed(
  events: EngineEvent[],
  verbose: boolean,
  maxLines = 50
): string[] {
  const formatted = events.map((e) => formatFeedEvent(e, verbose));
  if (formatted.length <= maxLines) {
    return formatted;
  }
  return formatted.slice(formatted.length - maxLines);
}

export function EventFeed(props: EventFeedProps): string[] {
  return formatEventFeed(props.events, props.verbose, props.maxLines);
}
