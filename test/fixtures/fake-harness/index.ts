import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionId } from "../../../src/contracts/index.js";

export type FakeScenarioName =
  | "success"
  | "edit_files"
  | "verify_fail_then_fix"
  | "hang"
  | "crash"
  | "soft_deny"
  | "budget_overshoot"
  | "rate_limit"
  | "resume";

export interface FakeScenarioConfig {
  scenario: FakeScenarioName;
  filesToEdit?: Record<string, string>;
  denialTool?: string;
  denialReason?: string;
  budgetLimitUsd?: number;
  rateLimitResetMs?: number;
  attempt?: number;
  sessionId?: SessionId;
}

export async function* emitClaudeDialectEvents(
  scenario: FakeScenarioName,
  options?: Record<string, unknown>
): AsyncIterable<string> {
  const sessionId =
    (options?.sessionId as string) ??
    "fake-session-" + Math.random().toString(36).slice(2, 10);
  const model = (options?.model as string) ?? "claude-haiku-5-5";
  const cwd = (options?.cwd as string) ?? process.cwd();

  // Line 1: system init event
  yield JSON.stringify({
    type: "system",
    subtype: "init",
    cwd,
    session_id: sessionId,
    tools: ["Bash", "Edit"],
    model,
  });

  switch (scenario) {
    case "success": {
      yield JSON.stringify({
        type: "assistant",
        message: {
          model,
          id: "msg_fake_1",
          role: "assistant",
          content: [{ type: "text", text: "Task completed successfully." }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Task completed successfully.",
        total_cost_usd: 0.0001,
        usage: { input_tokens: 10, output_tokens: 5 },
        permission_denials: [],
        session_id: sessionId,
      });
      break;
    }

    case "edit_files": {
      const filesToEdit =
        (options?.filesToEdit as Record<string, string>) ?? {};
      const filePaths = Object.keys(filesToEdit);
      const targetFile = filePaths[0] ?? "test.txt";
      yield JSON.stringify({
        type: "assistant",
        message: {
          model,
          id: "msg_fake_edit",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_fake_edit",
              name: "Edit",
              input: {
                path: targetFile,
                content: filesToEdit[targetFile] ?? "edited",
              },
            },
          ],
          usage: { input_tokens: 15, output_tokens: 8 },
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_fake_edit",
              content: `Updated ${targetFile}`,
              is_error: false,
            },
          ],
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: `Successfully edited ${filePaths.length || 1} file(s).`,
        total_cost_usd: 0.0002,
        usage: { input_tokens: 15, output_tokens: 8 },
        permission_denials: [],
        session_id: sessionId,
      });
      break;
    }

    case "soft_deny": {
      const tool = (options?.denialTool as string) ?? "Bash";
      const reason =
        (options?.denialReason as string) ?? "Permission denied by policy";
      yield JSON.stringify({
        type: "assistant",
        message: {
          model,
          id: "msg_fake_deny",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_fake_deny",
              name: tool,
              input: { command: "touch /tmp/denied" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "system",
        subtype: "permission_denied",
        tool_name: tool,
        tool_use_id: "toolu_fake_deny",
        decision_reason_type: "mode",
        message: reason,
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_fake_deny",
              content: reason,
              is_error: true,
            },
          ],
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Continuing despite tool denial.",
        total_cost_usd: 0.0001,
        usage: { input_tokens: 10, output_tokens: 5 },
        permission_denials: [
          {
            tool_name: tool,
            tool_use_id: "toolu_fake_deny",
            tool_input: { command: "touch /tmp/denied" },
          },
        ],
        session_id: sessionId,
      });
      break;
    }

    case "budget_overshoot": {
      yield JSON.stringify({
        type: "assistant",
        message: {
          model,
          id: "msg_fake_budget",
          role: "assistant",
          content: [{ type: "text", text: "Processing tokens..." }],
          usage: { input_tokens: 100000, output_tokens: 50000 },
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        result: "Max budget exceeded",
        total_cost_usd: 15.5,
        usage: { input_tokens: 100000, output_tokens: 50000 },
        permission_denials: [],
        session_id: sessionId,
      });
      break;
    }

    case "rate_limit": {
      yield JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 60,
          rateLimitType: "five_hour",
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "result",
        subtype: "error_rate_limit",
        is_error: true,
        result: "Rate limit exceeded",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        permission_denials: [],
        session_id: sessionId,
      });
      break;
    }

    case "resume": {
      yield JSON.stringify({
        type: "assistant",
        message: {
          model,
          id: "msg_fake_resume",
          role: "assistant",
          content: [{ type: "text", text: "Resumed session successfully." }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
        session_id: sessionId,
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Resumed session completed.",
        total_cost_usd: 0.0001,
        usage: { input_tokens: 5, output_tokens: 5 },
        permission_denials: [],
        session_id: sessionId,
      });
      break;
    }

    case "verify_fail_then_fix": {
      const isResumed = Boolean(options?.isResumed);
      if (!isResumed) {
        yield JSON.stringify({
          type: "assistant",
          message: {
            model,
            id: "msg_fake_broken",
            role: "assistant",
            content: [
              {
                type: "text",
                text: "First attempt: verification check failed.",
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          session_id: sessionId,
        });
        yield JSON.stringify({
          type: "result",
          subtype: "error_verify_failed",
          is_error: true,
          result: "Verification failed.",
          total_cost_usd: 0.0001,
          usage: { input_tokens: 10, output_tokens: 5 },
          permission_denials: [],
          session_id: sessionId,
        });
      } else {
        yield JSON.stringify({
          type: "assistant",
          message: {
            model,
            id: "msg_fake_fixed",
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Second attempt: fixed and verified.",
              },
            ],
            usage: { input_tokens: 12, output_tokens: 6 },
          },
          session_id: sessionId,
        });
        yield JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Fixed and verified.",
          total_cost_usd: 0.0002,
          usage: { input_tokens: 12, output_tokens: 6 },
          permission_denials: [],
          session_id: sessionId,
        });
      }
      break;
    }

    case "hang": {
      setInterval(() => {}, 10000);
      await new Promise(() => {});
      break;
    }

    case "crash": {
      break;
    }
  }
}

export async function runFakeScenario(
  config: FakeScenarioConfig,
  dialect: "claude",
  args: string[]
): Promise<number> {
  const isResumed =
    args.includes("--resume") ||
    (config.attempt !== undefined && config.attempt > 1);

  if (config.scenario === "edit_files") {
    const filesToEdit = config.filesToEdit ?? { "edited.txt": "sample edit" };
    for (const [relPath, content] of Object.entries(filesToEdit)) {
      mkdirSync(dirname(relPath), { recursive: true });
      writeFileSync(relPath, content, "utf8");
    }
  } else if (config.scenario === "verify_fail_then_fix") {
    if (!isResumed) {
      writeFileSync("verify_target.txt", "broken state", "utf8");
    } else {
      writeFileSync("verify_target.txt", "fixed state", "utf8");
    }
  }

  if (config.scenario === "hang") {
    setInterval(() => {}, 10000);
    await new Promise(() => {});
    return 0;
  }

  if (config.scenario === "crash") {
    return 1;
  }

  for await (const line of emitClaudeDialectEvents(config.scenario, {
    ...config,
    isResumed,
  })) {
    process.stdout.write(line + "\n");
  }

  if (config.scenario === "budget_overshoot") {
    return 1;
  }
  if (config.scenario === "rate_limit") {
    return 1;
  }
  if (config.scenario === "verify_fail_then_fix" && !isResumed) {
    return 1;
  }

  return 0;
}
