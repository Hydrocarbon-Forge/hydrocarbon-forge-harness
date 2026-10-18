#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { takeCall, applyCall } from "../scenario.mjs";

/**
 * OpenCode fake dialect event emitter.
 * Emits NDJSON lines mimicking OpenCode (2.0.21) CLI JSON output stream.
 *
 * @param {string} scenario
 * @param {Record<string, unknown>} [options]
 * @returns {AsyncIterable<string>}
 */
export async function* emitOpenCodeDialectEvents(scenario, options = {}) {
  const sessionId =
    /** @type {string} */ (options?.sessionId) ??
    "ses_" + Math.random().toString(36).slice(2, 10);
  const isResumed = Boolean(options?.isResumed);

  const stepStart = (id = "prt_step_start_" + Math.random().toString(36).slice(2, 8)) =>
    JSON.stringify({
      type: "step_start",
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        id,
        sessionID: sessionId,
        messageID: "msg_" + Math.random().toString(36).slice(2, 8),
        type: "step-start",
      },
    });

  const textEvent = (text) =>
    JSON.stringify({
      type: "text",
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        id: "prt_text_" + Math.random().toString(36).slice(2, 8),
        sessionID: sessionId,
        messageID: "msg_" + Math.random().toString(36).slice(2, 8),
        type: "text",
        text,
        time: { start: Date.now() - 100, end: Date.now() },
      },
    });

  const toolUseEvent = (tool, input, output = "", exitCode = 0) =>
    JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        partID: "prt_tool_" + Math.random().toString(36).slice(2, 8),
        sessionID: sessionId,
        messageID: "msg_" + Math.random().toString(36).slice(2, 8),
        type: "tool",
        id: "call_" + Math.random().toString(36).slice(2, 10),
        tool,
        state: {
          status: "completed",
          input,
          output,
          title: tool,
          metadata: {
            metadata: {
              status: "completed",
              truncated: false,
              exit: exitCode,
            },
            content: [{ type: "text", text: output }],
            providerCall: { executed: false },
            providerResult: { executed: false },
            rawInput: JSON.stringify(input),
          },
          time: { start: Date.now() - 50, end: Date.now() },
        },
      },
    });

  const stepFinish = (tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost = 0) =>
    JSON.stringify({
      type: "step_finish",
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        id: "prt_finish_" + Math.random().toString(36).slice(2, 8),
        sessionID: sessionId,
        messageID: "msg_" + Math.random().toString(36).slice(2, 8),
        type: "step-finish",
        reason: "stop",
        cost,
        tokens,
      },
    });

  const errorEvent = (errorType, message) =>
    JSON.stringify({
      type: "error",
      timestamp: Date.now(),
      sessionID: sessionId,
      error: {
        type: errorType,
        message,
      },
    });

  switch (scenario) {
    case "success": {
      yield stepStart();
      yield textEvent("OK");
      yield stepFinish({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, 0);
      break;
    }

    case "edit_files": {
      const filesToEdit = /** @type {Record<string, string>} */ (options?.filesToEdit ?? { "edited.txt": "content" });
      const firstPath = Object.keys(filesToEdit)[0] ?? "test.txt";
      yield stepStart();
      yield toolUseEvent("edit", { path: firstPath, content: filesToEdit[firstPath] ?? "updated" }, `Updated ${firstPath}`);
      yield stepFinish({ input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, 0.0001);
      break;
    }

    case "verify_fail_then_fix": {
      if (!isResumed) {
        yield stepStart();
        yield toolUseEvent("edit", { path: "verify_target.txt", content: "broken state" }, "Wrote broken state", 1);
      } else {
        yield stepStart();
        yield toolUseEvent("edit", { path: "verify_target.txt", content: "fixed state" }, "Wrote fixed state", 0);
        yield stepFinish({ input: 25, output: 12, reasoning: 0, cache: { read: 0, write: 0 } }, 0.0002);
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

    case "soft_deny": {
      yield stepStart();
      yield textEvent("I can't run shell commands — no shell/bash tool is available in this session.");
      break;
    }

    case "budget_overshoot": {
      yield stepStart();
      yield stepFinish({ input: 100000, output: 50000, reasoning: 0, cache: { read: 0, write: 0 } }, 15.5);
      break;
    }

    case "rate_limit": {
      yield errorEvent("provider.rate-limit", "Rate limit exceeded");
      break;
    }

    case "resume": {
      yield stepStart();
      yield textEvent(`Resumed session ${sessionId}: completed.`);
      yield stepFinish({ input: 8, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, 0);
      break;
    }

    default: {
      yield stepStart();
      yield textEvent("OK");
      yield stepFinish({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, 0);
      break;
    }
  }
}

/**
 * Run OpenCode dialect based on FAKE_SCENARIO_FILE.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function runDialect(argv, env) {
  if (argv.includes("--version")) {
    process.stdout.write("opencode 2.0.21\n");
    return 0;
  }

  let sessionId;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-s" || argv[i] === "--session") && i + 1 < argv.length) {
      sessionId = argv[++i];
    }
  }

  if (!sessionId) {
    sessionId = "ses_" + Math.random().toString(36).slice(2, 14);
  }

  const { call } = takeCall(env.FAKE_SCENARIO_FILE);
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

  const stepStart = () =>
    JSON.stringify({
      type: "step_start",
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        id: "prt_step_start_" + Math.random().toString(36).slice(2, 8),
        sessionID: sessionId,
        messageID: "msg_" + Math.random().toString(36).slice(2, 8),
        type: "step-start",
      },
    });

  if (call.failure === "rate_limit") {
    process.stdout.write(stepStart() + "\n");
    process.stdout.write(
      JSON.stringify({
        type: "error",
        timestamp: Date.now(),
        sessionID: sessionId,
        error: {
          type: "provider.rate-limit",
          message: "Rate limit exceeded",
        },
      }) + "\n"
    );
    return 1;
  }

  // 1. step_start
  process.stdout.write(stepStart() + "\n");

  // 2. text
  const reply =
    call.failure === "permission_denial"
      ? (call.reply ?? "I can't run shell commands — no shell/bash tool is available in this session.")
      : (call.reply ?? "DONE");

  process.stdout.write(
    JSON.stringify({
      type: "text",
      timestamp: Date.now(),
      sessionID: sessionId,
      part: {
        id: "prt_text_" + Math.random().toString(36).slice(2, 8),
        sessionID: sessionId,
        messageID: "msg_" + Math.random().toString(36).slice(2, 8),
        type: "text",
        text: reply,
        time: { start: Date.now() - 50, end: Date.now() },
      },
    }) + "\n"
  );

  // 3. step_finish (if call.usage !== null)
  if (call.usage !== null) {
    const rawUsage = call.usage;
    process.stdout.write(
      JSON.stringify({
        type: "step_finish",
        timestamp: Date.now(),
        sessionID: sessionId,
        part: {
          id: "prt_finish_" + Math.random().toString(36).slice(2, 8),
          sessionID: sessionId,
          messageID: "msg_" + Math.random().toString(36).slice(2, 8),
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: {
            input: rawUsage?.input ?? 10,
            output: rawUsage?.output ?? 5,
            reasoning: rawUsage?.reasoning ?? 0,
            cache: {
              read: rawUsage?.cache_read ?? 0,
              write: rawUsage?.cache_write ?? 0,
            },
          },
        },
      }) + "\n"
    );
  }

  return call.exit_code ?? 0;
}

// CLI entry point when executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    process.stdout.write("opencode 2.0.21\n");
    process.exit(0);
  }

  let scenario = process.env.FAKE_SCENARIO || "success";
  let sessionId = process.env.FAKE_SESSION_ID;
  let isResumed = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s" || arg === "--session") {
      sessionId = args[++i];
      isResumed = true;
      if (scenario === "success") {
        scenario = "resume";
      }
    } else if (arg === "--scenario") {
      scenario = args[++i];
    }
  }

  // Check last positional arg for prompt scenario hints
  const lastArg = args[args.length - 1];
  if (lastArg && !lastArg.startsWith("-")) {
    if (lastArg.startsWith("scenario:")) {
      scenario = lastArg.slice("scenario:".length);
    } else if (lastArg.includes("hang")) {
      scenario = "hang";
    } else if (lastArg.includes("crash")) {
      scenario = "crash";
    } else if (lastArg.includes("budget")) {
      scenario = "budget_overshoot";
    } else if (lastArg.includes("rate_limit")) {
      scenario = "rate_limit";
    } else if (lastArg.includes("soft_deny")) {
      scenario = "soft_deny";
    }
  }

  if (scenario === "edit_files") {
    mkdirSync(dirname("edited.txt"), { recursive: true });
    writeFileSync("edited.txt", "sample edit", "utf8");
  } else if (scenario === "verify_fail_then_fix") {
    if (!isResumed) {
      writeFileSync("verify_target.txt", "broken state", "utf8");
    } else {
      writeFileSync("verify_target.txt", "fixed state", "utf8");
    }
  }

  if (scenario === "hang") {
    setInterval(() => {}, 10000);
    await new Promise(() => {});
    process.exit(0);
  }

  if (scenario === "crash") {
    process.exit(1);
  }

  for await (const line of emitOpenCodeDialectEvents(scenario, {
    sessionId,
    isResumed,
  })) {
    process.stdout.write(line + "\n");
  }

  if (scenario === "budget_overshoot" || scenario === "rate_limit") {
    process.exit(1);
  }
  if (scenario === "verify_fail_then_fix" && !isResumed) {
    process.exit(1);
  }

  process.exit(0);
}
