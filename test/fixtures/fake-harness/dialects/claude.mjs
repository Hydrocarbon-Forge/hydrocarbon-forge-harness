import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { takeCall, applyCall, taskKeyFromCwd } from "../scenario.mjs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R8.2 isolation probe (scenario 9). The worker writes probe/<name>.txt in its cwd, then records
 * what it can see: the probe/ listing, the top-level listing, `git status --short` and the
 * content of README.md, as <dir>/seen-<name>.json. The record is what the test compares.
 *
 * @param {{ dir: string, name: string }} probe
 */
async function runProbe(probe) {
  const cwd = process.cwd();
  fs.mkdirSync(`${cwd}/probe`, { recursive: true });
  fs.writeFileSync(`${cwd}/probe/${probe.name}.txt`, `${probe.name}\n`, "utf8");
  fs.mkdirSync(probe.dir, { recursive: true });
  const status = execFileSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
  const record = {
    name: probe.name,
    top: fs.readdirSync(cwd).filter((f) => f !== ".git").sort(),
    probe: fs.readdirSync(`${cwd}/probe`).sort(),
    status: status.split("\n").filter((l) => l.length > 0),
    readme: fs.readFileSync(`${cwd}/README.md`, "utf8"),
  };
  fs.writeFileSync(`${probe.dir}/seen-${probe.name}.json`, JSON.stringify(record, null, 2), "utf8");
}

/**
 * R8.3 trace (a concurrency probe). Writes <dir>/start-<name>.json when the session starts and
 * <dir>/end-<name>.json when the process exits (a killed process leaves no end record). With
 * wait_for, the session waits until every named session overlapped it in time, or timeout_ms passes,
 * and writes <dir>/barrier-<name>.json saying whether the wait was met. A named session overlaps when
 * it started and had not ended before this session started (sessions that run one after another
 * never meet each other's barrier). The check is by interval, so a short session is not missed.
 *
 * @param {{ dir: string, name: string, wait_for?: string[], timeout_ms?: number }} trace
 */
async function runTrace(trace) {
  fs.mkdirSync(trace.dir, { recursive: true });
  const myStart = Date.now();
  fs.writeFileSync(`${trace.dir}/start-${trace.name}.json`, JSON.stringify({ pid: process.pid, at: myStart }), "utf8");
  process.on("exit", () => {
    try {
      fs.writeFileSync(`${trace.dir}/end-${trace.name}.json`, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
    } catch {}
  });
  if (Array.isArray(trace.wait_for) && trace.wait_for.length > 0) {
    const deadline = Date.now() + (trace.timeout_ms ?? 5000);
    let met = false;
    for (;;) {
      // A named session that has started overlaps this one if it has not ended, or ended after
      // this session started. It is seen while this session is still running, so it started before
      // this session ended.
      const overlapped = (name) => {
        if (!fs.existsSync(`${trace.dir}/start-${name}.json`)) return false;
        const endFile = `${trace.dir}/end-${name}.json`;
        if (!fs.existsSync(endFile)) return true;
        return JSON.parse(fs.readFileSync(endFile, "utf8")).at > myStart;
      };
      if (trace.wait_for.every(overlapped)) {
        met = true;
        break;
      }
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(`${trace.dir}/barrier-${trace.name}.json`, JSON.stringify({ met, at: Date.now() }), "utf8");
  }
}

/**
 * Runs the Claude CLI dialect.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function runDialect(argv, env) {
  const argvLog = env.FAKE_ARGV_LOG || process.env.FAKE_ARGV_LOG;
  if (argvLog) {
    fs.appendFileSync(argvLog, JSON.stringify({ argv }) + "\n", "utf8");
  }

  if (argv.includes("--version")) {
    process.stdout.write("2.1.304\n");
    return 0;
  }

  let sessionId;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[++i];
    } else if (argv[i] === "--resume" && i + 1 < argv.length) {
      sessionId = argv[++i];
    }
  }

  if (sessionId !== undefined && !UUID_REGEX.test(sessionId)) {
    process.stderr.write("Error: Invalid session ID. Must be a valid UUID.\n");
    return 1;
  }

  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }

  let scenarioFile = env.FAKE_SCENARIO_FILE;
  if (!scenarioFile && process.platform === "linux") {
    try {
      let p = process.ppid;
      while (p > 1 && !scenarioFile) {
        const ppidEnviron = fs.readFileSync(`/proc/${p}/environ`, "utf8");
        const entry = ppidEnviron.split("\0").find((e) => e.startsWith("FAKE_SCENARIO_FILE="));
        if (entry) {
          scenarioFile = entry.slice("FAKE_SCENARIO_FILE=".length);
          break;
        }
        const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8");
        const parts = stat.split(" ");
        p = parseInt(parts[3], 10);
      }
    } catch {}
  }

  const { call } = takeCall(scenarioFile, taskKeyFromCwd(process.cwd()));
  applyCall(call, process.cwd());

  if (call.probe) {
    await runProbe(call.probe);
  }

  if (call.trace) {
    await runTrace(call.trace);
  }

  if (call.delay_ms && call.delay_ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, call.delay_ms));
  }

  if (call.failure === "crash") {
    process.stderr.write("fake-harness: simulated crash\n");
    return 1;
  }

  if (call.failure === "hang") {
    if (scenarioFile) {
      fs.writeFileSync(`${scenarioFile}.pid`, String(process.pid), "utf8");
    }
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
    return 0;
  }

  if (call.failure === "rate_limit") {
    process.stdout.write(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: Math.floor(Date.now() / 1000) + 60,
          rateLimitType: "five_hour",
        },
        session_id: sessionId,
      }) + "\n"
    );
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "error_rate_limit",
        is_error: true,
        result: "Rate limit exceeded (rate_limit)",
        total_cost_usd: 0,
        usage: {
          input_tokens: call.usage?.input ?? 0,
          output_tokens: call.usage?.output ?? 0,
        },
        permission_denials: [],
        session_id: sessionId,
      }) + "\n"
    );
    return 1;
  }

  // claude stopped the session at its --max-budget-usd cap (the fixture budget-exceeded.ndjson shape).
  if (call.failure === "budget") {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        result: "",
        total_cost_usd: call.cost_usd ?? 0.0001,
        usage: { input_tokens: call.usage?.input ?? 0, output_tokens: call.usage?.output ?? 0 },
        permission_denials: [],
        errors: ["Reached maximum budget ($0.001)"],
        session_id: sessionId,
      }) + "\n"
    );
    return 1;
  }

  // An error result with no reply text: the subtype and the error lines are all the harness reports.
  if (call.failure === "error_result") {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        permission_denials: [],
        errors: ["fake harness aborted the turn"],
        session_id: sessionId,
      }) + "\n"
    );
    return 1;
  }

  const reply = call.reply ?? "DONE";
  const rawUsage = call.usage;
  const usageTokens = {
    input_tokens: rawUsage?.input ?? 10,
    output_tokens: rawUsage?.output ?? 5,
    ...(rawUsage?.cache_read !== undefined
      ? { cache_read_input_tokens: rawUsage.cache_read }
      : {}),
    ...(rawUsage?.cache_write !== undefined
      ? { cache_creation_input_tokens: rawUsage.cache_write }
      : {}),
  };
  const costUsd = call.cost_usd !== undefined ? call.cost_usd : 0.0001;

  // 1. system init
  process.stdout.write(
    JSON.stringify({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: sessionId,
      tools: [],
      mcp_servers: [],
      model: "claude-haiku-5-5",
      permissionMode: "dontAsk",
      claude_code_version: "2.1.304",
    }) + "\n"
  );

  // 2. permission_denial event if requested
  if (call.failure === "permission_denial") {
    process.stdout.write(
      JSON.stringify({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "toolu_fake_deny",
        decision_reason_type: "mode",
        message: "Permission to use Bash has been denied",
        session_id: sessionId,
      }) + "\n"
    );
  }

  // 3. assistant text
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-haiku-5-5",
        id: "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: reply }],
        usage: {
          input_tokens: usageTokens.input_tokens,
          output_tokens: usageTokens.output_tokens,
        },
      },
      session_id: sessionId,
    }) + "\n"
  );

  // 4. result
  const permissionDenials =
    call.failure === "permission_denial"
      ? [{ tool_name: "Bash", tool_use_id: "toolu_fake_deny" }]
      : [];

  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: reply,
      total_cost_usd: costUsd,
      usage: usageTokens,
      permission_denials: permissionDenials,
      session_id: sessionId,
    }) + "\n"
  );

  return call.exit_code ?? 0;
}
