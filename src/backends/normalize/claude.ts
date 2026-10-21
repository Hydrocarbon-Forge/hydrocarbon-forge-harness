import type {
  BackendEvent,
  PricingTable,
  SessionId,
  SessionResult,
  UsageRecord,
} from "../../contracts/index.js";
import { nowIsoTimestamp } from "../../util/index.js";
import { calculateCostUsd } from "../pricing.js";

export interface ClaudeNormalizerOptions {
  model?: string;
  sessionId?: SessionId;
  seenDenials?: Set<string>;
  pricing?: PricingTable;
}

export interface ClaudeRawContentBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ClaudeRawDenial {
  tool_name: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

export interface ClaudeRawResultEvent {
  type: "result";
  subtype?: string;
  session_id?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  result?: string;
  permission_denials?: ClaudeRawDenial[];
}

export function extractClaudeUsage(
  raw: unknown,
  fallbackModel: string,
  pricing?: PricingTable
): UsageRecord {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const u = (obj.usage && typeof obj.usage === "object" ? obj.usage : obj) as Record<string, any>;

  let model = fallbackModel;
  const modelUsage = obj.modelUsage ?? u.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    let maxOutput = -1;
    let topModel: string | undefined;
    for (const [k, v] of Object.entries(modelUsage)) {
      const out =
        typeof (v as any)?.outputTokens === "number"
          ? (v as any).outputTokens
          : 0;
      if (out > maxOutput) {
        maxOutput = out;
        topModel = k;
      }
    }
    if (topModel) {
      model = topModel;
    }
  }

  const input_tokens = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output_tokens = typeof u.output_tokens === "number" ? u.output_tokens : 0;

  const cache_write_tokens =
    typeof u.cache_creation_input_tokens === "number"
      ? u.cache_creation_input_tokens
      : typeof u.cache_write_tokens === "number"
      ? u.cache_write_tokens
      : undefined;

  const cache_read_tokens =
    typeof u.cache_read_input_tokens === "number"
      ? u.cache_read_input_tokens
      : typeof u.cache_read_tokens === "number"
      ? u.cache_read_tokens
      : undefined;

  const reasoning_tokens =
    typeof u.output_tokens_details?.thinking_tokens === "number"
      ? u.output_tokens_details.thinking_tokens
      : typeof u.reasoning_tokens === "number"
      ? u.reasoning_tokens
      : undefined;

  let cost_usd = 0;
  let cost_source: "reported" | "computed" | "unknown" = "unknown";

  const totalCost = obj.total_cost_usd !== undefined ? obj.total_cost_usd : u.total_cost_usd;
  if (typeof totalCost === "number" && Number.isFinite(totalCost)) {
    cost_usd = totalCost;
    cost_source = "reported";
  } else if (pricing) {
    const computed = calculateCostUsd(pricing, model, {
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
    });
    cost_usd = computed.cost_usd;
    cost_source = computed.cost_source;
  } else {
    cost_usd = 0;
    cost_source = "unknown";
  }

  const record: UsageRecord = {
    backend: "claude",
    model,
    input_tokens,
    output_tokens,
    ...(cache_read_tokens !== undefined ? { cache_read_tokens } : {}),
    ...(cache_write_tokens !== undefined ? { cache_write_tokens } : {}),
    ...(reasoning_tokens !== undefined ? { reasoning_tokens } : {}),
    cost_usd,
    cost_source,
    at: nowIsoTimestamp(),
  };

  return record;
}

export function extractClaudeSessionResult(
  events: BackendEvent[],
  exitCode: number | null,
  killedFor?: "budget" | "timeout" | "cancel"
): SessionResult {
  let sessionId = "";
  let resultEvent: Extract<BackendEvent, { type: "session.result" }> | undefined;
  let latestUsage: UsageRecord | undefined;
  const denials: { tool: string; reason?: string }[] = [];
  const seenDenials = new Set<string>();

  for (const ev of events) {
    if (ev.type === "session.started") {
      sessionId = ev.session_id;
    } else if (ev.type === "session.result") {
      resultEvent = ev;
    } else if (ev.type === "usage") {
      latestUsage = ev.record;
    } else if (ev.type === "permission.denied") {
      const key = `${ev.tool}:${ev.reason ?? ""}`;
      if (!seenDenials.has(key)) {
        seenDenials.add(key);
        denials.push(
          ev.reason !== undefined ? { tool: ev.tool, reason: ev.reason } : { tool: ev.tool }
        );
      }
    }
  }

  const defaultUsage: UsageRecord = {
    backend: "claude",
    model: "unknown",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_source: "computed",
    at: nowIsoTimestamp(),
  };

  const usage = resultEvent?.usage ?? latestUsage ?? defaultUsage;

  if (resultEvent) {
    const ok = killedFor ? false : resultEvent.ok;
    const finalKilled =
      killedFor ?? (resultEvent.stop_reason === "budget" ? "budget" : undefined);
    const res: SessionResult = {
      ok,
      session_id: sessionId,
      final_text: resultEvent.final_text,
      usage,
      exit_code: exitCode,
      denials,
      ...(finalKilled !== undefined ? { killed_for: finalKilled } : {}),
    };
    return res;
  }

  if (killedFor !== undefined) {
    const res: SessionResult = {
      ok: false,
      session_id: sessionId,
      final_text: "",
      usage,
      exit_code: exitCode,
      denials,
      killed_for: killedFor,
    };
    return res;
  }

  const res: SessionResult = {
    ok: false,
    session_id: sessionId,
    final_text: "Process exited unexpectedly without session result",
    usage,
    exit_code: exitCode,
    denials,
  };
  return res;
}

export function normalizeClaudeEvent(
  raw: unknown,
  options?: ClaudeNormalizerOptions
): BackendEvent[] {
  if (raw == null || typeof raw !== "object") {
    return [];
  }

  const eventObj = raw as Record<string, any>;
  const type = eventObj.type;

  if (type === "system") {
    if (eventObj.subtype === "init") {
      const session_id =
        typeof eventObj.session_id === "string"
          ? eventObj.session_id
          : options?.sessionId ?? "";
      return [{ type: "session.started", session_id }];
    }
    if (eventObj.subtype === "permission_denied") {
      const tool = typeof eventObj.tool_name === "string" ? eventObj.tool_name : "";
      const reason = typeof eventObj.message === "string" ? eventObj.message : undefined;
      const key = eventObj.tool_use_id ? String(eventObj.tool_use_id) : tool;
      if (options?.seenDenials) {
        if (options.seenDenials.has(key)) {
          return [];
        }
        options.seenDenials.add(key);
      }
      return [
        {
          type: "permission.denied",
          tool,
          ...(reason !== undefined ? { reason } : {}),
        },
      ];
    }
    return [];
  }

  if (type === "assistant") {
    const content = eventObj.message?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const events: BackendEvent[] = [];
    for (const block of content) {
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        events.push({ type: "assistant.text", text: block.text });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool.call",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input_summary: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return events;
  }

  if (type === "user") {
    const content = eventObj.message?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const events: BackendEvent[] = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        const outputSummary =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        events.push({
          type: "tool.result",
          id: String(block.tool_use_id ?? ""),
          ok: !block.is_error,
          output_summary: outputSummary,
        });
      }
    }
    return events;
  }

  if (type === "rate_limit_event") {
    const info = eventObj.rate_limit_info;
    if (info?.status === "allowed") {
      return [];
    }
    const message =
      typeof eventObj.message === "string"
        ? eventObj.message
        : `Claude rate limit status: ${info?.status ?? "rejected"}`;
    return [{ type: "error", kind: "rate_limit", message }];
  }

  if (type === "error" || type === "stream_error") {
    const rawMsg =
      typeof eventObj.message === "string"
        ? eventObj.message
        : typeof eventObj.error === "string"
        ? eventObj.error
        : typeof eventObj.error?.message === "string"
        ? eventObj.error.message
        : JSON.stringify(eventObj.error ?? eventObj);
    const lower = rawMsg.toLowerCase();
    let kind: "rate_limit" | "auth" | "crash" | "protocol" = "protocol";
    if (lower.includes("rate limit") || lower.includes("429")) {
      kind = "rate_limit";
    } else if (
      lower.includes("authentication") ||
      lower.includes("invalid api key") ||
      lower.includes("401")
    ) {
      kind = "auth";
    }
    return [{ type: "error", kind, message: rawMsg }];
  }

  if (type === "result") {
    let model: string | undefined;
    if (eventObj.modelUsage && typeof eventObj.modelUsage === "object") {
      let maxOutput = -1;
      let topModel: string | undefined;
      for (const [k, v] of Object.entries(eventObj.modelUsage)) {
        const out =
          typeof (v as any)?.outputTokens === "number"
            ? (v as any).outputTokens
            : 0;
        if (out > maxOutput) {
          maxOutput = out;
          topModel = k;
        }
      }
      if (topModel) {
        model = topModel;
      }
    }
    if (!model) {
      model = options?.model;
    }
    if (!model && typeof eventObj.model === "string") {
      model = eventObj.model;
    }
    if (!model) {
      model = "unknown";
    }

    const usage = extractClaudeUsage(eventObj, model, options?.pricing);
    const events: BackendEvent[] = [
      {
        type: "usage",
        record: usage,
        cumulative: false,
      },
    ];

    if (Array.isArray(eventObj.permission_denials)) {
      for (const denial of eventObj.permission_denials) {
        const tool = denial.tool_name ?? "";
        const key = denial.tool_use_id ? String(denial.tool_use_id) : tool;
        if (!options?.seenDenials?.has(key)) {
          options?.seenDenials?.add(key);
          events.push({ type: "permission.denied", tool });
        }
      }
    }

    const subtype = eventObj.subtype;
    const isError = Boolean(eventObj.is_error);
    const finalText = typeof eventObj.result === "string" ? eventObj.result : "";
    const stopReason =
      typeof eventObj.stop_reason === "string" ? eventObj.stop_reason : undefined;

    if (isError) {
      const lower = (finalText || String(subtype ?? "")).toLowerCase();
      if (lower.includes("rate limit") || lower.includes("429")) {
        events.push({
          type: "error",
          kind: "rate_limit",
          message: finalText || "Rate limit exceeded",
        });
      } else if (
        lower.includes("authentication") ||
        lower.includes("invalid api key") ||
        lower.includes("401")
      ) {
        events.push({
          type: "error",
          kind: "auth",
          message: finalText || "Authentication failed",
        });
      } else if (subtype !== "error_max_budget_usd") {
        // The result's subtype and error lines name a failure the exit code alone does not (R7.9).
        const errorLines = Array.isArray(eventObj.errors)
          ? eventObj.errors.filter((line: unknown): line is string => typeof line === "string" && line.trim() !== "")
          : [];
        const named = [String(subtype ?? "error"), ...errorLines].join(": ");
        events.push({ type: "error", kind: "crash", message: named });
      }
    }

    if (subtype === "success" && !isError) {
      events.push({
        type: "session.result",
        ok: true,
        stop_reason: stopReason,
        final_text: finalText,
        usage,
        exit_code: 0,
      });
    } else if (subtype === "error_max_budget_usd") {
      events.push({
        type: "session.result",
        ok: false,
        stop_reason: "budget",
        final_text: finalText,
        usage,
        exit_code: 1,
      });
    } else {
      events.push({
        type: "session.result",
        ok: false,
        stop_reason: subtype ?? "error",
        final_text: finalText,
        usage,
        exit_code: 1,
      });
    }

    return events;
  }

  return [];
}
