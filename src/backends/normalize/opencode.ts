import type {
  BackendEvent,
  PricingTable,
  SessionId,
  UsageRecord,
} from "../../contracts/index.js";
import { nowIsoTimestamp } from "../../util/index.js";
import { calculateCostUsd } from "../pricing.js";

export interface OpenCodeRawEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

export interface OpenCodeNormalizeOptions {
  model: string;
  pricingTable?: PricingTable;
  fallbackSessionId?: SessionId;
}

export function parseOpenCodeEvent(
  raw: unknown,
  options: OpenCodeNormalizeOptions
): BackendEvent[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const rawObj = raw as Record<string, unknown>;
  if (typeof rawObj.type !== "string") {
    return [];
  }

  const type = rawObj.type;
  const events: BackendEvent[] = [];

  switch (type) {
    case "step_start": {
      const sessionId =
        (typeof rawObj.sessionID === "string" && rawObj.sessionID) ||
        options.fallbackSessionId ||
        "ses_unknown";
      events.push({
        type: "session.started",
        session_id: sessionId,
      });
      break;
    }

    case "text": {
      const part = rawObj.part as Record<string, unknown> | undefined;
      if (part && typeof part.text === "string") {
        const text = part.text;
        // Check for model refusal text indicating denied tools
        if (
          /no\s+(?:shell|bash|\w+\/bash|\w+\/shell)\s+tool\s+is\s+available/i.test(text) ||
          /can(?:'t|not)\s+run\s+shell/i.test(text)
        ) {
          events.push({
            type: "permission.denied",
            tool: "shell",
            reason: text,
          });
        } else if (
          /no\s+edit\s+tool\s+is\s+available/i.test(text) ||
          /can(?:'t|not)\s+edit/i.test(text)
        ) {
          events.push({
            type: "permission.denied",
            tool: "edit",
            reason: text,
          });
        } else if (
          /no\s+webfetch\s+tool\s+is\s+available/i.test(text) ||
          /can(?:'t|not)\s+(?:fetch|access\s+web)/i.test(text)
        ) {
          events.push({
            type: "permission.denied",
            tool: "webfetch",
            reason: text,
          });
        } else if (
          /no\s+websearch\s+tool\s+is\s+available/i.test(text) ||
          /can(?:'t|not)\s+search/i.test(text)
        ) {
          events.push({
            type: "permission.denied",
            tool: "websearch",
            reason: text,
          });
        }

        events.push({
          type: "assistant.text",
          text,
        });
      }
      break;
    }

    case "tool_use": {
      const part = rawObj.part as Record<string, unknown> | undefined;
      if (part && part.type === "tool") {
        const id = String(part.id ?? "");
        const name = String(part.tool ?? "");
        const state = part.state as Record<string, unknown> | undefined;
        events.push({
          type: "tool.call",
          id,
          name,
          input_summary: JSON.stringify(state?.input ?? {}),
        });

        if (state && state.status === "completed") {
          const metadata = state.metadata as Record<string, unknown> | undefined;
          const innerMeta = metadata?.metadata as Record<string, unknown> | undefined;
          const exit = innerMeta?.exit ?? metadata?.exit;
          const ok = exit !== undefined ? exit === 0 : true;
          events.push({
            type: "tool.result",
            id,
            ok,
            output_summary: String(state.output ?? ""),
          });
        }
      }
      break;
    }

    case "step_finish": {
      const part = rawObj.part as Record<string, unknown> | undefined;
      if (part && part.tokens && typeof part.tokens === "object") {
        const tokens = part.tokens as Record<string, unknown>;
        const cache = tokens.cache as Record<string, unknown> | undefined;
        const inputTokens = Number(tokens.input ?? 0);
        const outputTokens = Number(tokens.output ?? 0);
        const reasoningTokens =
          tokens.reasoning !== undefined ? Number(tokens.reasoning) : undefined;
        const cacheReadTokens =
          cache?.read !== undefined ? Number(cache.read) : undefined;
        const cacheWriteTokens =
          cache?.write !== undefined ? Number(cache.write) : undefined;

        let costUsd = Number(part.cost ?? 0);
        let costSource: "reported" | "computed" = "reported";

        if (costUsd === 0 && options.pricingTable) {
          try {
            const computed = calculateCostUsd(options.pricingTable, options.model, {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cache_read_tokens: cacheReadTokens,
              cache_write_tokens: cacheWriteTokens,
            });
            if (computed > 0) {
              costUsd = computed;
              costSource = "computed";
            }
          } catch {
            // Unlisted model in pricing table; retain 0 reported
          }
        }

        const usageRecord: UsageRecord = {
          backend: "opencode",
          model: options.model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cache_read_tokens: cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
          cost_usd: costUsd,
          cost_source: costSource,
          at: nowIsoTimestamp(),
        };

        events.push({
          type: "usage",
          record: usageRecord,
          cumulative: false,
        });
      }
      break;
    }

    case "error": {
      const err = (rawObj.error as Record<string, unknown> | undefined) ?? {};
      const errType = typeof err.type === "string" ? err.type : "";
      const errMsg = typeof err.message === "string" ? err.message : "";
      let kind: "auth" | "rate_limit" | "crash" | "protocol" = "protocol";

      if (errType === "provider.auth" || /403|unauthorized/i.test(errMsg)) {
        kind = "auth";
      } else if (/rate-?limit/i.test(errType) || /rate\s*limit/i.test(errMsg)) {
        kind = "rate_limit";
      } else if (errType === "provider.no-route") {
        kind = "crash";
      } else {
        kind = "protocol";
      }

      events.push({
        type: "error",
        kind,
        message: errMsg || "Unknown error",
      });
      break;
    }

    default:
      break;
  }

  return events;
}

export async function* normalizeOpenCodeStream(
  rawStream: AsyncIterable<unknown>,
  options: OpenCodeNormalizeOptions
): AsyncIterable<BackendEvent> {
  let activeSessionId: SessionId =
    options.fallbackSessionId ?? ("ses_" + Math.random().toString(36).slice(2, 10));
  let started = false;
  let hasFatalError = false;
  let accumulatedAssistantText = "";
  let hasSeenStepFinish = false;

  const cumulativeTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    hasReasoning: false,
    cacheRead: 0,
    hasCacheRead: false,
    cacheWrite: 0,
    hasCacheWrite: false,
    costUsd: 0,
    costSource: "reported" as "reported" | "computed",
  };

  for await (const raw of rawStream) {
    if (!raw || typeof raw !== "object") continue;
    const rawObj = raw as Record<string, unknown>;
    if (typeof rawObj.type !== "string") continue;

    if (typeof rawObj.sessionID === "string" && rawObj.sessionID) {
      activeSessionId = rawObj.sessionID;
    }

    if (!started) {
      yield {
        type: "session.started",
        session_id: activeSessionId,
      };
      started = true;
    }

    if (rawObj.type === "step_start") {
      // Step boundary: session already started, so ignore
      continue;
    }

    const events = parseOpenCodeEvent(raw, options);
    for (const event of events) {
      if (event.type === "error") {
        hasFatalError = true;
      } else if (event.type === "assistant.text") {
        accumulatedAssistantText = accumulatedAssistantText
          ? accumulatedAssistantText + "\n" + event.text
          : event.text;
      } else if (event.type === "usage") {
        hasSeenStepFinish = true;
        cumulativeTokens.input += event.record.input_tokens;
        cumulativeTokens.output += event.record.output_tokens;
        cumulativeTokens.costUsd += event.record.cost_usd;
        if (event.record.reasoning_tokens !== undefined) {
          cumulativeTokens.reasoning =
            (cumulativeTokens.reasoning || 0) + event.record.reasoning_tokens;
          cumulativeTokens.hasReasoning = true;
        }
        if (event.record.cache_read_tokens !== undefined) {
          cumulativeTokens.cacheRead =
            (cumulativeTokens.cacheRead || 0) + event.record.cache_read_tokens;
          cumulativeTokens.hasCacheRead = true;
        }
        if (event.record.cache_write_tokens !== undefined) {
          cumulativeTokens.cacheWrite =
            (cumulativeTokens.cacheWrite || 0) + event.record.cache_write_tokens;
          cumulativeTokens.hasCacheWrite = true;
        }
        if (event.record.cost_source === "computed") {
          cumulativeTokens.costSource = "computed";
        }
      }

      yield event;
    }
  }

  // Handle stream end:
  if (!started) {
    yield {
      type: "session.started",
      session_id: activeSessionId,
    };
    started = true;
  }

  let finalUsageRecord: UsageRecord;
  if (!hasSeenStepFinish) {
    // Record warning regarding missing step_finish on stdout
    process.stdout.write("Warning: missing step_finish in OpenCode stream\n");
    finalUsageRecord = {
      backend: "opencode",
      model: options.model,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      cost_source: "reported",
      at: nowIsoTimestamp(),
    };
  } else {
    finalUsageRecord = {
      backend: "opencode",
      model: options.model,
      input_tokens: cumulativeTokens.input,
      output_tokens: cumulativeTokens.output,
      ...(cumulativeTokens.hasReasoning
        ? { reasoning_tokens: cumulativeTokens.reasoning }
        : {}),
      ...(cumulativeTokens.hasCacheRead
        ? { cache_read_tokens: cumulativeTokens.cacheRead }
        : {}),
      ...(cumulativeTokens.hasCacheWrite
        ? { cache_write_tokens: cumulativeTokens.cacheWrite }
        : {}),
      cost_usd: cumulativeTokens.costUsd,
      cost_source: cumulativeTokens.costSource,
      at: nowIsoTimestamp(),
    };
  }

  yield {
    type: "session.result",
    ok: !hasFatalError,
    final_text: accumulatedAssistantText,
    usage: finalUsageRecord,
    exit_code: hasFatalError ? 1 : 0,
  };
}
