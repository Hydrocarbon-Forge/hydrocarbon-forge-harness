import type {
  BackendEvent,
  PricingTable,
  SessionId,
  UsageRecord,
} from "../../contracts/index.js";
import { UsageRecord as UsageRecordSchema } from "../../contracts/index.js";
import { calculateCostUsd } from "../pricing.js";
import { nowIsoTimestamp } from "../../util/index.js";

export interface AgyInitEvent {
  event: "init";
  conversation_id: string;
  init: {
    model?: string;
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
}

export interface AgyUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyToolInfo {
  name: string;
  parameters: Record<string, unknown>;
}

export interface AgyDeniedAction {
  action: string;
  display_name?: string;
}

export interface AgyStepUpdate {
  conversation_id?: string;
  step_index: number;
  state: "ACTIVE" | "DONE";
  step_type: "user_input" | "agent_response" | "tool" | "system_message";
  text_delta?: string;
  usage?: AgyUsage;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  subagent_info?: unknown;
}

export interface AgyStepUpdateEvent {
  event: "step_update";
  step_update: AgyStepUpdate;
}

export interface AgyResultPayload {
  conversation_id: string;
  status: "SUCCESS" | "ERROR";
  response: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
  denied_actions?: AgyDeniedAction[];
  error?: string;
}

export interface AgyResultEvent {
  event: "result";
  result: AgyResultPayload;
}

export type AgyRawEvent =
  | AgyInitEvent
  | AgyStepUpdateEvent
  | AgyResultEvent;

export interface AgyNormalizerOptions {
  model: string;
  pricing: PricingTable;
  onDenial?: (denial: { tool: string; reason?: string }) => void;
}

interface RecordedDenial {
  tool: string;
  reason?: string;
  action?: string;
}

export class AgyNormalizer {
  private readonly options: AgyNormalizerOptions;
  private conversationId?: SessionId;
  private responseText = "";
  private lastUsage?: UsageRecord;
  private readonly denials: RecordedDenial[] = [];
  private resultEmitted = false;
  private model: string;
  private stderrBuffer = "";

  constructor(options: AgyNormalizerOptions) {
    this.options = options;
    this.model = options.model;
  }

  normalizeEvent(raw: AgyRawEvent): BackendEvent[] {
    const events: BackendEvent[] = [];

    if (raw.event === "init") {
      this.conversationId = raw.conversation_id;
      if (raw.init?.model) {
        this.model = raw.init.model;
      }
      events.push({
        type: "session.started",
        session_id: raw.conversation_id,
      });
      return events;
    }

    if (raw.event === "step_update") {
      const su = raw.step_update;
      if (su.conversation_id && !this.conversationId) {
        this.conversationId = su.conversation_id;
      }

      if (su.subagent_info !== undefined) {
        events.push({
          type: "subagent",
          raw: su.subagent_info,
        });
      }

      if (su.step_type === "agent_response") {
        if (su.text_delta) {
          this.responseText += su.text_delta;
          events.push({
            type: "assistant.text",
            text: su.text_delta,
          });
        }
        if (su.state === "DONE" && su.usage) {
          const rec = this.toUsageRecord(su.usage);
          this.lastUsage = rec;
          events.push({
            type: "usage",
            record: rec,
            cumulative: false,
          });
        }
      } else if (su.step_type === "tool" && (su.tool_name || su.tool_info)) {
        if (su.state === "ACTIVE") {
          const name = su.tool_name ?? su.tool_info?.name ?? "unknown";
          const inputSummary =
            su.tool_info?.parameters !== undefined
              ? JSON.stringify(su.tool_info.parameters)
              : "{}";
          events.push({
            type: "tool.call",
            id: String(su.step_index),
            name,
            input_summary: inputSummary,
          });
        } else if (su.state === "DONE") {
          events.push({
            type: "tool.result",
            id: String(su.step_index),
            ok: true,
            output_summary: "",
          });
        }
      }
      return events;
    }

    if (raw.event === "result") {
      const res = raw.result;
      if (res.conversation_id && !this.conversationId) {
        this.conversationId = res.conversation_id;
      }
      if (res.response !== undefined) {
        this.responseText = res.response;
      }
      if (res.usage) {
        this.lastUsage = this.toUsageRecord(res.usage);
      }
      if (res.denied_actions && Array.isArray(res.denied_actions)) {
        for (const denial of res.denied_actions) {
          const denialEvt = this.recordDenial({
            tool: denial.display_name ?? denial.action,
            reason: denial.action,
            action: denial.action,
          });
          if (denialEvt) {
            events.push(denialEvt);
          }
        }
      }

      if (res.status === "ERROR") {
        const errorMsg = res.error ?? (res.response || "Agy execution failed");
        let kind: "rate_limit" | "auth" | "crash" = "crash";
        const lower = errorMsg.toLowerCase();
        if (
          lower.includes("rate limit") ||
          lower.includes("resource exhausted") ||
          lower.includes("quota exceeded") ||
          lower.includes("429")
        ) {
          kind = "rate_limit";
        } else if (
          lower.includes("unauthorized") ||
          lower.includes("invalid api key") ||
          lower.includes("auth") ||
          lower.includes("401") ||
          lower.includes("forbidden") ||
          lower.includes("403")
        ) {
          kind = "auth";
        }
        events.push({
          type: "error",
          kind,
          message: errorMsg,
        });
      }

      const ok = res.status === "SUCCESS" && this.denials.length === 0;
      const exitCode = res.status === "SUCCESS" ? 0 : 1;
      this.resultEmitted = true;

      events.push({
        type: "session.result",
        ok,
        stop_reason: res.status === "SUCCESS" ? "completed" : "error",
        final_text: this.responseText,
        usage: this.lastUsage,
        exit_code: exitCode,
      });

      return events;
    }

    return events;
  }

  scanStderr(chunk: string): BackendEvent[] {
    this.stderrBuffer += chunk;
    const events: BackendEvent[] = [];
    const regex =
      /jetski:\s*no output produced\s*[—\-]\s*a tool required the "([^"]+)" permission that headless mode cannot prompt for, so it was auto-denied/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.stderrBuffer)) !== null) {
      const toolPermission = match[1];
      const denialEvt = this.recordDenial({
        tool: toolPermission,
        reason: toolPermission,
        action: toolPermission,
      });
      if (denialEvt) {
        events.push(denialEvt);
      }
    }
    return events;
  }

  finalize(exitCode: number | null): BackendEvent[] {
    if (this.resultEmitted) {
      return [];
    }
    this.resultEmitted = true;
    const ok = exitCode === 0 && this.denials.length === 0;
    return [
      {
        type: "session.result",
        ok,
        stop_reason: exitCode === 0 ? "completed" : "exit",
        final_text: this.responseText,
        usage: this.lastUsage,
        exit_code: exitCode,
      },
    ];
  }

  getDenials(): Array<{ tool: string; reason?: string }> {
    return this.denials.map((d) => ({
      tool: d.tool,
      ...(d.reason ? { reason: d.reason } : {}),
    }));
  }

  getUsage(): UsageRecord | undefined {
    return this.lastUsage;
  }

  getConversationId(): SessionId | undefined {
    return this.conversationId;
  }

  getFinalText(): string {
    return this.responseText;
  }

  private recordDenial(denial: {
    tool: string;
    reason?: string;
    action?: string;
  }): BackendEvent | null {
    const existing = this.denials.find(
      (d) =>
        (denial.action &&
          (d.action === denial.action ||
            d.tool === denial.action ||
            d.reason === denial.action)) ||
        d.tool === denial.tool ||
        (denial.tool && d.action === denial.tool)
    );

    if (existing) {
      if (denial.tool && denial.tool !== denial.action) {
        existing.tool = denial.tool;
      }
      if (denial.reason) {
        existing.reason = denial.reason;
      }
      if (denial.action && !existing.action) {
        existing.action = denial.action;
      }
      return null;
    }

    const recorded: RecordedDenial = {
      tool: denial.tool,
      reason: denial.reason,
      action: denial.action,
    };
    this.denials.push(recorded);
    this.options.onDenial?.({
      tool: recorded.tool,
      ...(recorded.reason ? { reason: recorded.reason } : {}),
    });

    return {
      type: "permission.denied",
      tool: recorded.tool,
      ...(recorded.reason ? { reason: recorded.reason } : {}),
    };
  }

  private toUsageRecord(usage: AgyUsage): UsageRecord {
    const tokens = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_tokens,
    };

    const costUsd = calculateCostUsd(
      this.options.pricing,
      this.model,
      tokens
    );

    const record: UsageRecord = {
      backend: "agy",
      model: this.model,
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      cost_usd: costUsd,
      cost_source: "computed",
      at: nowIsoTimestamp(),
    };

    if (usage.cache_read_tokens !== undefined) {
      record.cache_read_tokens = usage.cache_read_tokens;
    }
    if (usage.thinking_tokens !== undefined) {
      record.reasoning_tokens = usage.thinking_tokens;
    }

    return UsageRecordSchema.parse(record);
  }
}

export async function* normalizeAgyStream(
  stream: AsyncIterable<AgyRawEvent>,
  stderrStream: AsyncIterable<string>,
  options: AgyNormalizerOptions
): AsyncIterable<BackendEvent> {
  const normalizer = new AgyNormalizer(options);

  const buffer: BackendEvent[] = [];
  let pendingResult: BackendEvent | null = null;
  let error: unknown = null;
  let done = false;
  let notify: (() => void) | null = null;

  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  const stdoutPromise = (async () => {
    try {
      for await (const raw of stream) {
        const events = normalizer.normalizeEvent(raw);
        for (const e of events) {
          if (e.type === "session.result") {
            pendingResult = e;
          } else {
            buffer.push(e);
            wake();
          }
        }
      }
    } catch (err) {
      error = err;
      wake();
    }
  })();

  const stderrPromise = (async () => {
    try {
      for await (const chunk of stderrStream) {
        const events = normalizer.scanStderr(chunk);
        for (const e of events) {
          buffer.push(e);
          wake();
        }
      }
    } catch (err) {
      error = err;
      wake();
    }
  })();

  Promise.all([stdoutPromise, stderrPromise]).finally(() => {
    if (pendingResult) {
      if (pendingResult.type === "session.result") {
        if (normalizer.getDenials().length > 0) {
          pendingResult = {
            ...pendingResult,
            ok: false,
          };
        }
      }
      buffer.push(pendingResult);
    } else {
      const finalizeEvents = normalizer.finalize(0);
      buffer.push(...finalizeEvents);
    }
    done = true;
    wake();
  });

  while (true) {
    while (buffer.length > 0) {
      yield buffer.shift()!;
    }
    if (error) {
      throw error;
    }
    if (done) {
      break;
    }
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}
