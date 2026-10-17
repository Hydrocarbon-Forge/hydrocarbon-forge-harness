import { GovernorTool, RunId, PermissionMode } from "../contracts/index.js";

export interface OpenAIToolParam {
  type: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: OpenAIToolParam;
  };
}

export const GOVERNOR_TOOL_DEFINITIONS: readonly OpenAIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "start_run",
      description: "Start a new Substrate run with request, optional mode, and permission_mode",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "Natural language description of the task or goal",
          },
          mode: {
            type: "string",
            enum: ["solo", "plan"],
            description: "Execution mode: solo for single-task or plan for full planner decomposition",
          },
          permission_mode: {
            type: "string",
            enum: ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"],
            description: "Harness permission mode",
          },
        },
        required: ["request"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_only",
      description: "Draft an execution plan without executing tasks",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "Goal to plan",
          },
        },
        required: ["request"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_run",
      description: "Resume a paused or previously executed Substrate run",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Canonical run ID to resume (e.g. r_234567ABCDEF)",
          },
        },
        required: ["run_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_status",
      description: "Check the status and task states of a Substrate run",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Optional run ID to inspect. If omitted, checks current run.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_cost",
      description: "Show cost and token usage breakdown for a run",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Optional run ID. If omitted, shows current run cost.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_run",
      description: "Cancel an active Substrate run",
      parameters: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            description: "Run ID to cancel",
          },
        },
        required: ["run_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Ask the user a short clarifying question before making a routing decision",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The clarifying question to present to the user",
          },
        },
        required: ["question"],
      },
    },
  },
] as const;

const CANONICAL_NAMES = new Set(GOVERNOR_TOOL_DEFINITIONS.map((d) => d.function.name));

export function parseGovernorToolCall(name: string, rawArgs: unknown): GovernorTool {
  if (!CANONICAL_NAMES.has(name)) {
    throw new Error(`Unrecognized governor tool: ${name}`);
  }

  let args: Record<string, unknown>;
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
    } catch (err) {
      throw new Error(`Invalid JSON string arguments for tool ${name}: ${(err as Error).message}`);
    }
  } else if (typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  } else {
    throw new Error(`Arguments for tool ${name} must be an object or valid JSON string`);
  }

  switch (name) {
    case "start_run": {
      if (typeof args.request !== "string" || args.request.trim().length === 0) {
        throw new Error("start_run requires a non-empty request string");
      }
      if (args.mode !== undefined && args.mode !== "solo" && args.mode !== "plan") {
        throw new Error(`Invalid mode for start_run: ${String(args.mode)}`);
      }
      if (args.permission_mode !== undefined) {
        const permResult = PermissionMode.safeParse(args.permission_mode);
        if (!permResult.success) {
          throw new Error(`Invalid permission_mode for start_run: ${String(args.permission_mode)}`);
        }
      }
      const parsed = GovernorTool.parse({
        name: "start_run",
        args,
      });
      return parsed;
    }

    case "plan_only": {
      if (typeof args.request !== "string" || args.request.trim().length === 0) {
        throw new Error("plan_only requires a non-empty request string");
      }
      const parsed = GovernorTool.parse({
        name: "plan_only",
        args,
      });
      return parsed;
    }

    case "resume_run": {
      if (typeof args.run_id !== "string" || !RunId.safeParse(args.run_id).success) {
        throw new Error(`resume_run requires a valid run_id: ${String(args.run_id)}`);
      }
      const parsed = GovernorTool.parse({
        name: "resume_run",
        args,
      });
      return parsed;
    }

    case "run_status": {
      if (args.run_id !== undefined && (typeof args.run_id !== "string" || !RunId.safeParse(args.run_id).success)) {
        throw new Error(`run_status requires a valid run_id if provided: ${String(args.run_id)}`);
      }
      const parsed = GovernorTool.parse({
        name: "run_status",
        args,
      });
      return parsed;
    }

    case "show_cost": {
      if (args.run_id !== undefined && (typeof args.run_id !== "string" || !RunId.safeParse(args.run_id).success)) {
        throw new Error(`show_cost requires a valid run_id if provided: ${String(args.run_id)}`);
      }
      const parsed = GovernorTool.parse({
        name: "show_cost",
        args,
      });
      return parsed;
    }

    case "cancel_run": {
      if (typeof args.run_id !== "string" || !RunId.safeParse(args.run_id).success) {
        throw new Error(`cancel_run requires a valid run_id: ${String(args.run_id)}`);
      }
      const parsed = GovernorTool.parse({
        name: "cancel_run",
        args,
      });
      return parsed;
    }

    case "ask_user": {
      if (typeof args.question !== "string" || args.question.trim().length === 0) {
        throw new Error("ask_user requires a non-empty question string");
      }
      const parsed = GovernorTool.parse({
        name: "ask_user",
        args,
      });
      return parsed;
    }

    default:
      throw new Error(`Unrecognized governor tool: ${name}`);
  }
}

export function validateGovernorTool(tool: GovernorTool): boolean {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return false;
  }

  const parsed = GovernorTool.safeParse(tool);
  if (!parsed.success) {
    return false;
  }

  if (tool.name === "start_run" && (typeof tool.args.request !== "string" || tool.args.request.trim().length === 0)) {
    return false;
  }
  if (tool.name === "plan_only" && (typeof tool.args.request !== "string" || tool.args.request.trim().length === 0)) {
    return false;
  }
  if (tool.name === "ask_user" && (typeof tool.args.question !== "string" || tool.args.question.trim().length === 0)) {
    return false;
  }

  return true;
}
