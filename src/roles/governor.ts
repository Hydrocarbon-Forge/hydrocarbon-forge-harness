import {
  Diagnostic,
  GovernorTool,
  RoutingDecision,
} from "../contracts/index.js";
import {
  GOVERNOR_TOOL_DEFINITIONS,
  parseGovernorToolCall,
} from "./governor-tools.js";

export interface GovernorClientOptions {
  endpoint: string;
  model?: string;
  timeoutMs?: number;
  enableThinking?: boolean;
}

export interface GovernorIntakeResult {
  toolCalls: GovernorTool[];
  decision?: RoutingDecision;
  clarificationQuestion?: string;
  content: string;
}

function getCompletionUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export async function checkGovernorHealth(
  endpoint: string,
  timeoutMs = 10000,
): Promise<boolean> {
  if (!endpoint || typeof endpoint !== "string") {
    return false;
  }

  const base = endpoint.replace(/\/+$/, "");
  const healthUrl = base.endsWith("/v1") ? `${base.slice(0, -3)}/health` : `${base}/health`;

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 200) {
      return true;
    }
    if (res.status === 404) {
      const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
      const res2 = await fetch(modelsUrl, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res2.status === 200;
    }
    return false;
  } catch {
    return false;
  }
}

const ROUTING_DECISION_SCHEMA = {
  name: "RoutingDecision",
  strict: true,
  schema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["solo", "plan"] },
      task_class: { type: "string" },
      planner_route: { type: "string" },
      rationale: { type: "string" },
      needs_clarification: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["mode", "rationale"],
    additionalProperties: false,
  },
};

export async function callGovernorIntake(
  prompt: string,
  opts: GovernorClientOptions,
): Promise<GovernorIntakeResult> {
  const url = getCompletionUrl(opts.endpoint);
  const timeoutMs = opts.timeoutMs ?? 10000;

  const requestBody = {
    model: opts.model ?? "default",
    messages: [
      {
        role: "system",
        content:
          "You are the Substrate governor agent acting as the conversational front door and request router. Route user requests into solo or plan mode and invoke typed tools when appropriate. You cannot plan, implement, or edit repo files.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    tools: GOVERNOR_TOOL_DEFINITIONS,
    tool_choice: "auto",
    response_format: {
      type: "json_schema",
      json_schema: ROUTING_DECISION_SCHEMA,
    },
    chat_template_kwargs: {
      enable_thinking: false,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Governor HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const content: string = message?.content ?? "";

  const toolCalls: GovernorTool[] = [];
  let clarificationQuestion: string | undefined;

  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc.type === "function" && tc.function) {
        try {
          const parsed = parseGovernorToolCall(tc.function.name, tc.function.arguments);
          toolCalls.push(parsed);
          if (parsed.name === "ask_user") {
            clarificationQuestion = parsed.args.question;
          }
        } catch {
          // Ignore tool parse failures from raw model output
        }
      }
    }
  }

  let decision: RoutingDecision | undefined;
  if (content.trim().length > 0) {
    try {
      const parsed = JSON.parse(content);
      const parsedDecision = RoutingDecision.safeParse(parsed);
      if (parsedDecision.success) {
        decision = parsedDecision.data;
        if (
          !clarificationQuestion &&
          decision.needs_clarification &&
          decision.needs_clarification.length > 0
        ) {
          clarificationQuestion = decision.needs_clarification[0];
        }
      }
    } catch {
      // Content was not valid JSON
    }
  }

  return {
    toolCalls,
    decision,
    clarificationQuestion,
    content,
  };
}

export async function runGovernorSemanticLint(
  plan: unknown,
  repoRoot: string,
  opts: GovernorClientOptions,
): Promise<Diagnostic[]> {
  const url = getCompletionUrl(opts.endpoint);
  const timeoutMs = opts.timeoutMs ?? 10000;

  const systemPrompt = [
    "You are the Substrate advisory semantic linter.",
    "Evaluate execution plans for semantic defects using checks S001–S004:",
    "- S001: Ambiguity in task specification",
    "- S002: Missing edge cases or error handling",
    "- S003: Mismatch between task spec and contract stubs",
    "- S004: Task scope too large or complex for a single task",
    "Return a JSON object containing an array of diagnostics under the 'diagnostics' key.",
    "Each diagnostic must have: code (S001, S002, S003, or S004), severity ('info'), message (string), and optional task (string).",
  ].join("\n");

  const requestBody = {
    model: opts.model ?? "default",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Repository root: ${repoRoot}\n\nPlan:\n${JSON.stringify(plan, null, 2)}`,
      },
    ],
    chat_template_kwargs: {
      enable_thinking: true,
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as any;
    const choice = data?.choices?.[0];
    const message = choice?.message;
    const content = message?.content ?? "";

    if (!content.trim()) {
      return [];
    }

    const parsed = JSON.parse(content);
    const rawList = Array.isArray(parsed?.diagnostics)
      ? parsed.diagnostics
      : Array.isArray(parsed)
        ? parsed
        : [];

    const diagnostics: Diagnostic[] = [];
    for (const d of rawList) {
      if (typeof d?.code === "string" && typeof d?.message === "string") {
        const diag: Diagnostic = {
          code: d.code,
          severity: "info",
          message: d.message,
          task: typeof d.task === "string" ? d.task : undefined,
          path: typeof d.path === "string" ? d.path : undefined,
        };
        const validation = Diagnostic.safeParse(diag);
        if (validation.success) {
          diagnostics.push(validation.data);
        }
      }
    }

    return diagnostics;
  } catch {
    return [];
  }
}
