import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import type {
  Capabilities,
  EnvReport,
  HarnessAdapter,
  SessionHandle,
  SessionResult,
  SpawnRequest,
  BackendEvent,
} from "../../contracts/index.js";
import { spawnSupervisedProcess } from "../process.js";
import { readNdjsonLines } from "../ndjson.js";
import {
  normalizeClaudeEvent,
  extractClaudeSessionResult,
} from "../normalize/claude.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_VERSION_PIN = "2.1.301";

export const CLAUDE_CAPABILITIES: Capabilities = {
  name: "claude",
  version_pin: CLAUDE_VERSION_PIN,
  effort: true,
  structured_output: false,
  budget_flag: true,
  cost_reported: true,
  resume: true,
  permission_denial_signal: "event",
  sandbox_flag: false,
  native_subagents_headless: false,
};

export interface ClaudeAdapterOptions {
  bin?: string;
  versionPin?: string;
  maxConcurrency?: number;
}

export function buildClaudeArgs(req: SpawnRequest): string[] {
  const args: string[] = [
    "-p",
    req.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  if (req.model) {
    args.push("--model", req.model);
  }

  if (req.effort) {
    args.push("--effort", req.effort);
  }

  if (req.session?.resume) {
    args.push("--resume", req.session.resume);
  } else if (req.session?.id) {
    args.push("--session-id", req.session.id);
  } else {
    args.push("--session-id", crypto.randomUUID());
  }

  args.push("--permission-mode", "dontAsk", "--permission-prompts", "none");

  if (req.permission.allow.length > 0) {
    args.push("--allowedTools", req.permission.allow.join(","));
  }

  const disallowed = ["Agent", ...req.permission.deny.filter((t) => t !== "Agent")];
  args.push("--disallowedTools", disallowed.join(","));

  if (req.budget.max_usd !== undefined && req.budget.max_usd > 0) {
    args.push("--max-budget-usd", req.budget.max_usd.toString());
  }

  return args;
}

const ALLOWED_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
];

export function scrubClaudeEnv(
  customEnv?: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  if (customEnv) {
    for (const [k, v] of Object.entries(customEnv)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
  }
  return env;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly capabilities: Capabilities;
  private readonly options: ClaudeAdapterOptions;

  constructor(options?: ClaudeAdapterOptions) {
    this.options = options ?? {};
    this.capabilities = {
      ...CLAUDE_CAPABILITIES,
      ...(this.options.maxConcurrency !== undefined
        ? { max_concurrency: this.options.maxConcurrency }
        : {}),
    };
  }

  async validateEnvironment(): Promise<EnvReport> {
    const bin = this.options.bin ?? "claude";
    const pin = this.options.versionPin ?? CLAUDE_VERSION_PIN;

    try {
      const { stdout } = await execFileAsync(bin, ["--version"], {
        timeout: 5000,
        env: scrubClaudeEnv(),
      });
      const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      if (!match) {
        return {
          ok: false,
          pin_matches: false,
          problems: ["Claude CLI binary not found or failed to execute"],
        };
      }
      const version = match[1];
      if (version === pin) {
        return {
          ok: true,
          version,
          pin_matches: true,
          problems: [],
        };
      }
      return {
        ok: true,
        version,
        pin_matches: false,
        problems: [`Installed version ${version} differs from pinned version ${pin}`],
      };
    } catch {
      return {
        ok: false,
        pin_matches: false,
        problems: ["Claude CLI binary not found or failed to execute"],
      };
    }
  }

  spawn(req: SpawnRequest): SessionHandle {
    const sessionId =
      req.session?.resume ?? req.session?.id ?? crypto.randomUUID();

    const reqWithSession: SpawnRequest = {
      ...req,
      session: {
        ...req.session,
        id: req.session?.resume ? req.session?.id : sessionId,
        resume: req.session?.resume,
      },
    };

    const args = buildClaudeArgs(reqWithSession);
    const scrubbed = scrubClaudeEnv(req.env);
    const envRecord: Record<string, string> = {};
    for (const [k, v] of Object.entries(scrubbed)) {
      if (typeof v === "string") {
        envRecord[k] = v;
      }
    }

    const rawDir = join(req.cwd, "raw");
    mkdirSync(rawDir, { recursive: true });
    const rawFilePath = join(rawDir, `${sessionId}.ndjson`);
    const rawWriteStream = createWriteStream(rawFilePath, { flags: "a" });
    rawWriteStream.on("error", (err) => {
      console.error(`Failed to write raw stream to ${rawFilePath}:`, err);
    });

    const proc = spawnSupervisedProcess({
      command: this.options.bin ?? "claude",
      args,
      cwd: req.cwd,
      env: envRecord,
      timeoutMs: req.budget.timeout_ms,
    });

    const allEvents: BackendEvent[] = [];
    const seenDenials = new Set<string>();
    let done = false;
    let waitingConsumers: Array<() => void> = [];
    let killedFor: "budget" | "timeout" | "cancel" | undefined;

    const notifyConsumers = () => {
      const callbacks = waitingConsumers;
      waitingConsumers = [];
      for (const cb of callbacks) {
        cb();
      }
    };

    const processStdoutPromise = (async () => {
      try {
        for await (const line of readNdjsonLines(proc.stdout, {
          rawSink: (chunk) => {
            try {
              rawWriteStream.write(chunk);
            } catch (err) {
              console.error("Raw stream write error:", err);
            }
          },
          onParseError: () => {},
        })) {
          try {
            const item = JSON.parse(line);
            const evs = normalizeClaudeEvent(item, {
              model: req.model,
              sessionId,
              seenDenials,
            });
            for (const ev of evs) {
              allEvents.push(ev);
              notifyConsumers();
            }
          } catch {
            // Malformed JSON lines ignored
          }
        }
      } catch (err) {
        console.error("Error reading NDJSON stream:", err);
      } finally {
        await new Promise<void>((resolve) => {
          rawWriteStream.end(() => resolve());
        });
      }
    })();

    const lifecyclePromise = (async () => {
      const exitResult = await proc.wait();
      await processStdoutPromise;

      let finalKilledFor = killedFor ?? exitResult.killReason;
      if (!finalKilledFor && exitResult.timedOut) {
        finalKilledFor = "timeout";
      }

      const hasResultEvent = allEvents.some((e) => e.type === "session.result");

      if (!hasResultEvent && !finalKilledFor && exitResult.exitCode !== 0) {
        const crashError: BackendEvent = {
          type: "error",
          kind: "crash",
          message: `Process crashed with exit code ${exitResult.exitCode ?? "null"}`,
        };
        allEvents.push(crashError);
        notifyConsumers();
      }

      const sessionResult = extractClaudeSessionResult(
        allEvents,
        exitResult.exitCode,
        finalKilledFor
      );

      if (!allEvents.some((e) => e.type === "session.result")) {
        const syntheticResultEvent: BackendEvent = {
          type: "session.result",
          ok: sessionResult.ok,
          final_text: sessionResult.final_text,
          usage: sessionResult.usage,
          exit_code: sessionResult.exit_code,
          ...(sessionResult.killed_for !== undefined
            ? { stop_reason: sessionResult.killed_for }
            : {}),
        };
        allEvents.push(syntheticResultEvent);
        notifyConsumers();
      }

      done = true;
      notifyConsumers();

      return sessionResult;
    })();

    const eventsIterable: AsyncIterable<BackendEvent> = {
      async *[Symbol.asyncIterator]() {
        let index = 0;
        while (true) {
          while (index < allEvents.length) {
            yield allEvents[index++];
          }
          if (done) {
            break;
          }
          await new Promise<void>((resolve) => {
            waitingConsumers.push(resolve);
          });
        }
      },
    };

    return {
      pid: proc.pid,
      events: eventsIterable,
      result: () => lifecyclePromise,
      kill: async (reason: "budget" | "timeout" | "cancel") => {
        killedFor = killedFor ?? reason;
        await proc.kill(reason);
      },
    };
  }
}
