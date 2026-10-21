#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { takeCall, applyCall, taskKeyFromCwd } from "../scenario.mjs";

/**
 * Emit raw NDJSON lines for the agy dialect.
 *
 * @param {string} scenario
 * @param {Record<string, unknown>} [options]
 * @returns {AsyncIterable<string>}
 */
export async function* emitAgyDialectEvents(scenario, options = {}) {
  const conversationId =
    options.conversation_id ??
    options.sessionId ??
    options.resumeConversationId ??
    "bd58e925-652b-4856-b3f3-24ff2bfb8cb9";
  const model = options.model ?? "gemini-3.8-flash-low";
  const cwd = options.cwd ?? process.cwd();

  // Every session starts with an init event
  yield JSON.stringify({
    event: "init",
    conversation_id: conversationId,
    init: {
      model,
      cwd,
      tools: [
        "run_command",
        "write_to_file",
        "replace_file_content",
        "view_file",
        "read_url_content",
      ],
      permission_mode: "request-review",
    },
  });

  switch (scenario) {
    case "success": {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "Task completed successfully.",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "\n",
          duration_seconds: 1.0,
          usage: {
            input_tokens: 11827,
            output_tokens: 13,
            thinking_tokens: 12,
            cache_read_tokens: 0,
            total_tokens: 11840,
          },
        },
      });
      yield JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          response: "Task completed successfully.\n",
          duration_seconds: 1.1,
          num_turns: 1,
          usage: {
            input_tokens: 11827,
            output_tokens: 13,
            thinking_tokens: 12,
            cache_read_tokens: 0,
            total_tokens: 11840,
          },
        },
      });
      break;
    }

    case "soft_deny": {
      const toolName = options.denialTool ?? "run_command";
      const actionName = options.denialAction ?? "command";
      const displayName = options.denialDisplayName ?? "RunCommand";

      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          duration_seconds: 0.5,
          usage: {
            input_tokens: 11857,
            output_tokens: 125,
            thinking_tokens: 49,
            cache_read_tokens: 0,
            total_tokens: 11982,
          },
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: toolName,
          tool_info: {
            name: toolName,
            parameters: {
              CommandLine: "touch /tmp/denied",
            },
          },
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: toolName,
          duration_seconds: 0.03,
          tool_info: {
            name: toolName,
            parameters: {
              CommandLine: "touch /tmp/denied",
            },
          },
        },
      });
      yield JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          response: "",
          duration_seconds: 1.0,
          num_turns: 1,
          usage: {
            input_tokens: 11857,
            output_tokens: 125,
            thinking_tokens: 49,
            cache_read_tokens: 0,
            total_tokens: 11982,
          },
          denied_actions: [
            {
              action: actionName,
              display_name: displayName,
            },
          ],
        },
      });
      break;
    }

    case "resume": {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 2,
          state: "DONE",
          step_type: "user_input",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 3,
          state: "DONE",
          step_type: "system_message",
          duration_seconds: 0.0001,
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 4,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "Resumed session successfully.",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 4,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "\n",
          duration_seconds: 1.2,
          usage: {
            input_tokens: 12049,
            output_tokens: 5,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 12054,
          },
        },
      });
      yield JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          response: "Resumed session successfully.\n",
          duration_seconds: 2.5,
          num_turns: 2,
          usage: {
            input_tokens: 23884,
            output_tokens: 7,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 23891,
          },
        },
      });
      break;
    }

    case "edit_files": {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "Files edited successfully.",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "\n",
          duration_seconds: 0.8,
          usage: {
            input_tokens: 12000,
            output_tokens: 20,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 12020,
          },
        },
      });
      yield JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          response: "Files edited successfully.\n",
          duration_seconds: 0.9,
          num_turns: 1,
          usage: {
            input_tokens: 12000,
            output_tokens: 20,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 12020,
          },
        },
      });
      break;
    }

    case "budget_overshoot": {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 0,
          state: "DONE",
          step_type: "user_input",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "Processing heavy tokens...",
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "\n",
          duration_seconds: 1.0,
          usage: {
            input_tokens: 100000000,
            output_tokens: 50000000,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 150000000,
          },
        },
      });
      yield JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          response: "Token budget overshoot.\n",
          duration_seconds: 1.2,
          num_turns: 1,
          usage: {
            input_tokens: 100000000,
            output_tokens: 50000000,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 150000000,
          },
        },
      });
      break;
    }

    case "rate_limit": {
      yield JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "ERROR",
          response: "",
          error: "rate limit exceeded: quota exceeded for model",
          duration_seconds: 0,
          num_turns: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
          },
        },
      });
      break;
    }

    case "hang": {
      // Hold process open without emitting final result
      setInterval(() => {}, 10000);
      await new Promise(() => {});
      break;
    }

    case "crash": {
      break;
    }
  }
}

/**
 * Run a fake agy scenario as a child process.
 *
 * @param {string} scenario
 * @param {string[]} args
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<number>}
 */
export async function runAgyDialectScenario(scenario, args, options = {}) {
  let conversationId = options.conversation_id ?? options.sessionId;
  let effectiveScenario = scenario;
  let filesToEdit = options.filesToEdit;
  let denialTool = options.denialTool ?? "run_command";
  let denialAction = options.denialAction ?? "command";
  let denialDisplayName = options.denialDisplayName ?? "RunCommand";

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version") {
      process.stdout.write("1.4.2\n");
      return 0;
    }
    if (arg === "--conversation" && i + 1 < args.length) {
      conversationId = args[++i];
      if (effectiveScenario === "success") {
        effectiveScenario = "resume";
      }
    } else if (arg === "--scenario" && i + 1 < args.length) {
      effectiveScenario = args[++i];
    } else if (arg === "-p" && i + 1 < args.length) {
      const prompt = args[++i];
      if (prompt.startsWith("scenario:")) {
        effectiveScenario = prompt.slice("scenario:".length);
      } else if (prompt.includes("hang")) {
        effectiveScenario = "hang";
      } else if (prompt.includes("soft_deny")) {
        effectiveScenario = "soft_deny";
      } else if (prompt.includes("budget")) {
        effectiveScenario = "budget_overshoot";
      } else if (prompt.includes("rate_limit")) {
        effectiveScenario = "rate_limit";
      } else if (prompt.includes("crash")) {
        effectiveScenario = "crash";
      } else if (prompt.includes("resume")) {
        effectiveScenario = "resume";
      } else if (prompt.includes("edit_files")) {
        effectiveScenario = "edit_files";
      }
    } else if (arg === "--denial-tool" && i + 1 < args.length) {
      denialTool = args[++i];
      denialDisplayName = denialTool;
    }
  }

  if (effectiveScenario === "edit_files") {
    const files = filesToEdit ?? { "edited.txt": "sample edit from fake agy" };
    for (const [relPath, content] of Object.entries(files)) {
      mkdirSync(dirname(relPath), { recursive: true });
      writeFileSync(relPath, content, "utf8");
    }
  }

  if (effectiveScenario === "hang") {
    setInterval(() => {}, 10000);
    await new Promise(() => {});
    return 0;
  }

  if (effectiveScenario === "crash") {
    return 1;
  }

  if (effectiveScenario === "soft_deny") {
    // Write exact jetski stderr message matching spike S3
    process.stderr.write(
      `jetski: no output produced — a tool required the "${denialAction}" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.\n`
    );
  }

  const emitterOpts = {
    ...options,
    conversation_id: conversationId,
    denialTool,
    denialAction,
    denialDisplayName,
  };

  for await (const line of emitAgyDialectEvents(effectiveScenario, emitterOpts)) {
    process.stdout.write(line + "\n");
  }

  if (effectiveScenario === "rate_limit") {
    return 1;
  }

  // agy exits 0 even on soft_deny!
  return 0;
}

/**
 * Run agy dialect based on FAKE_SCENARIO_FILE.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function runDialect(argv, env) {
  // R2.6 Behavior 6: the first argument `models` answers with the captured
  // fixture verbatim, so the Done-when diff against it prints nothing.
  if (argv[0] === "models") {
    const dialectDir = dirname(fileURLToPath(import.meta.url));
    process.stdout.write(
      readFileSync(join(dialectDir, "..", "..", "backends", "agy", "models.txt"), "utf8")
    );
    return 0;
  }

  if (argv.includes("--version")) {
    process.stdout.write("1.4.2\n");
    return 0;
  }

  let conversationId;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--conversation" && i + 1 < argv.length) {
      conversationId = argv[++i];
    }
  }

  if (!conversationId) {
    conversationId = crypto.randomUUID();
  }

  const { call } = takeCall(env.FAKE_SCENARIO_FILE, taskKeyFromCwd(process.cwd()));
  applyCall(call, process.cwd());

  if (call.delay_ms && call.delay_ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, call.delay_ms));
  }

  if (call.failure === "crash") {
    process.stderr.write("fake-harness: simulated crash\n");
    return 1;
  }

  if (call.failure === "hang") {
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
    return 0;
  }

  if (call.failure === "rate_limit") {
    process.stdout.write(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "ERROR",
          response: "",
          error: "rate limit exceeded: quota exceeded for model",
          duration_seconds: 0,
          num_turns: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            thinking_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
          },
        },
      }) + "\n"
    );
    return 1;
  }

  if (call.failure === "permission_denial") {
    process.stderr.write(
      `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.\n`
    );
  }

  const reply = call.reply ?? "DONE";
  const rawUsage = call.usage;
  const inTokens = rawUsage?.input ?? 11827;
  const outTokens = rawUsage?.output ?? 13;
  const thinkTokens = rawUsage?.reasoning ?? 12;
  const cacheReadTokens = rawUsage?.cache_read ?? 0;
  const totalTokens = inTokens + outTokens;

  // 1. init
  process.stdout.write(
    JSON.stringify({
      event: "init",
      conversation_id: conversationId,
      init: {
        model: "gemini-3.8-flash-low",
        cwd: process.cwd(),
        tools: [
          "run_command",
          "write_to_file",
          "replace_file_content",
          "view_file",
          "read_url_content",
        ],
        permission_mode: "request-review",
      },
    }) + "\n"
  );

  // 2. step_update (user_input)
  process.stdout.write(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 0,
        state: "DONE",
        step_type: "user_input",
      },
    }) + "\n"
  );

  // 3. step_update (agent_response ACTIVE)
  process.stdout.write(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: reply,
      },
    }) + "\n"
  );

  // 4. step_update (agent_response DONE)
  process.stdout.write(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "\n",
        duration_seconds: 1.0,
        usage: {
          input_tokens: inTokens,
          output_tokens: outTokens,
          thinking_tokens: thinkTokens,
          cache_read_tokens: cacheReadTokens,
          total_tokens: totalTokens,
        },
      },
    }) + "\n"
  );

  // 5. result
  const deniedActions =
    call.failure === "permission_denial"
      ? [{ action: "command", display_name: "RunCommand" }]
      : undefined;

  process.stdout.write(
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "SUCCESS",
        response: reply + "\n",
        duration_seconds: 1.1,
        num_turns: 1,
        usage: {
          input_tokens: inTokens,
          output_tokens: outTokens,
          thinking_tokens: thinkTokens,
          cache_read_tokens: cacheReadTokens,
          total_tokens: totalTokens,
        },
        ...(deniedActions ? { denied_actions: deniedActions } : {}),
      },
    }) + "\n"
  );

  return call.exit_code ?? 0;
}

// CLI entrypoint if executed directly
const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === process.argv[1] ||
    (process.argv[1].endsWith("agy.mjs") && !process.argv[1].endsWith("/bin/agy")));

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    process.stdout.write("1.4.2\n");
    process.exit(0);
  }

  let scenario = process.env.FAKE_SCENARIO ?? "success";
  const code = await runAgyDialectScenario(scenario, args);
  process.exit(code);
}
