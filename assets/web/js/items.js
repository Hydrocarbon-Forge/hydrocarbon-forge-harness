// Turns one transcript line (docs/design/web-ui.md, 5.1 TranscriptLineOut) into display items, and keeps the
// per-session facts the views need: tool calls, tokens, cost, start and end. No DOM here.

/** A new cursor for a transcript: where it has read to, its items, and its running facts. */
export function newCursor() {
  return {
    lastIndex: -1,
    loaded: false,
    items: [],
    header: null,
    ended: false,
    ok: null,
    stats: { tools: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, costUnknown: false, startMs: null, endMs: null },
  };
}

function dividerText(header) {
  switch (header.role) {
    case "planner":
      return `planner session${header.model ? ` | ${header.model}` : ""}`;
    case "planner_chat":
      return "planner chat turn";
    case "repair":
      return `integration repair attempt | ${header.backend} ${header.model}`;
    default:
      return `task ${header.task_id} | generation ${header.generation} attempt ${header.attempt} | ${header.backend} ${header.model}`;
  }
}

function msOf(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The items one line adds to its transcript. Index 0 is the header, which starts the transcript with a divider.
 * A usage line adds no item (the totals move instead). Mutates `cursor` (the session's facts).
 */
export function itemsOfLine(line, cursor) {
  if (line.header) {
    cursor.header = line.header;
    cursor.stats.startMs = msOf(line.header.started_at);
    return [{ kind: "divider", ts: line.header.started_at, text: dividerText(line.header) }];
  }
  const event = line.event;
  if (!event) return [];
  const ts = line.ts;
  const stats = cursor.stats;
  switch (event.type) {
    case "session.started":
      return [{ kind: "meta", ts, text: "session started" }];
    case "assistant.text":
      return [{ kind: "text", ts, text: event.text }];
    case "tool.call":
      stats.tools += 1;
      return [{ kind: "tool", ts, name: event.name, arg: event.input_summary }];
    case "tool.result":
      return [{ kind: "result", ts, ok: event.ok, text: event.output_summary }];
    case "permission.denied":
      return [{ kind: "denied", ts, tool: event.tool, reason: event.reason ?? "" }];
    case "usage": {
      const record = event.record;
      if (event.cumulative) {
        stats.tokensIn = record.input_tokens;
        stats.tokensOut = record.output_tokens;
      } else {
        stats.tokensIn += record.input_tokens;
        stats.tokensOut += record.output_tokens;
      }
      if (record.cost_source === "unknown") stats.costUnknown = true;
      else stats.costUsd += record.cost_usd;
      return [];
    }
    case "subagent":
      return [{ kind: "subagent", ts, raw: event.raw }];
    case "error":
      return [{ kind: "error", ts, errorKind: event.kind, text: event.message }];
    case "session.result": {
      cursor.ended = true;
      cursor.ok = event.ok;
      stats.endMs = msOf(ts);
      return [
        {
          kind: "done",
          ts,
          ok: event.ok,
          exitCode: event.exit_code,
          finalText: event.final_text,
          tools: stats.tools,
          tokensIn: stats.tokensIn,
          tokensOut: stats.tokensOut,
          durationMs: stats.startMs !== null && stats.endMs !== null ? stats.endMs - stats.startMs : null,
        },
      ];
    }
    default:
      return [];
  }
}

/** Tokens a session has used so far (input plus output). */
export function tokensOf(cursor) {
  return cursor.stats.tokensIn + cursor.stats.tokensOut;
}
