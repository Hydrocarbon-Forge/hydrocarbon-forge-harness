import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import type {
  Capabilities,
  EnvReport,
  HarnessAdapter,
  ModelInfo,
  SessionHandle,
  SessionResult,
  SpawnRequest,
  BackendEvent,
} from "../../contracts/index.js";
import { harnessStderrDetail, spawnSupervisedProcess } from "../process.js";
import { readNdjsonLines } from "../ndjson.js";
import {
  normalizeClaudeEvent,
  extractClaudeSessionResult,
} from "../normalize/claude.js";
import { log } from "../../util/log.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_VERSION_PIN = "2.1.304";

export const CLAUDE_CAPABILITIES: Capabilities = {
  name: "claude",
  version_pin: CLAUDE_VERSION_PIN,
  effort: true,
  structured_output: false,
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
  /**
   * Model ids from settings and the price table, passed in by the registry.
   * Claude has no list command (S1), so these are the only ids the adapter can
   * report besides its documented aliases.
   */
  knownModels?: string[];
  /** The no-output idle watchdog, in milliseconds, for every session this adapter starts (0 or unset: off). */
  idleTimeoutMs?: number;
}

/** Documented Claude aliases (S1): the only ids the adapter reports on its own. */
const CLAUDE_ALIASES = ["haiku", "sonnet", "opus", "fable"];

/**
 * The Claude 5 family ids Substrate accepts for the claude harness, besides the aliases.
 * Each id is listed the same way as a settings model (source "settings"). Prices come from
 * the price table; an id with no price entry (claude-fable-5-1 today) is accepted and its
 * cost is reported as unknown.
 */
export const CLAUDE_FAMILY_IDS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

/** Efforts every alias and every known id accepts, in the order the CLI takes them. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function convertClaudePermissionRule(rule: string): string {
  const trimmed = rule.trim();
  if (!trimmed) return "";
  if (trimmed === "subagents") return "Agent";
  if (/^[A-Za-z]+\(.*\)$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("git ")) return `Bash(${trimmed}*)`;
  return trimmed;
}

export function buildClaudeArgs(req: SpawnRequest): string[] {
  // The prompt is not an argument: `claude -p` with no prompt argument reads it from stdin (see spawn), so a
  // long prompt cannot exceed the system's argument size limit (E2BIG).
  const args: string[] = [
    "-p",
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
    if (!UUID_REGEX.test(req.session.resume)) {
      throw new Error(`claude session id must be a UUID: ${req.session.resume}`);
    }
    args.push("--resume", req.session.resume);
  } else if (req.session?.id) {
    if (!UUID_REGEX.test(req.session.id)) {
      throw new Error(`claude session id must be a UUID: ${req.session.id}`);
    }
    args.push("--session-id", req.session.id);
  } else {
    throw new Error(`claude session id must be a UUID: undefined`);
  }

  if (req.system_append && req.system_append.trim().length > 0) {
    args.push("--append-system-prompt", req.system_append);
  }

  // Owner decision 2026-10-19: all harnesses run with permissions bypassed; the
  // engine's permission_mode is an approval gate and does not reach the harness.
  args.push("--dangerously-skip-permissions", "--permission-prompts", "none");

  const disallowedSet = new Set<string>(["Agent"]);
  for (const rule of req.permission.deny) {
    const converted = convertClaudePermissionRule(rule);
    if (converted) {
      disallowedSet.add(converted);
    }
  }
  const disallowed = Array.from(disallowedSet);
  args.push("--disallowedTools", disallowed.join(","));

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

  /**
   * The four documented aliases, then every model id the registry passed in
   * (settings roles, routing, and the price table), deduplicated with the first
   * occurrence winning. No process is run: Claude has no list command.
   */
  listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    const seen = new Set<string>();

    for (const id of CLAUDE_ALIASES) {
      seen.add(id);
      models.push({ id, efforts: [...CLAUDE_EFFORTS], source: "static" });
    }

    for (const id of this.options.knownModels ?? []) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push({ id, efforts: [...CLAUDE_EFFORTS], source: "settings" });
    }

    return Promise.resolve(models);
  }

  spawn(req: SpawnRequest): SessionHandle {
    const sessionId = req.session?.resume ?? req.session?.id;
    if (!sessionId || !UUID_REGEX.test(sessionId)) {
      throw new Error(`claude session id must be a UUID: ${sessionId}`);
    }

    const args = buildClaudeArgs(req);
    const scrubbed = scrubClaudeEnv(req.env);
    const envRecord: Record<string, string> = {};
    for (const [k, v] of Object.entries(scrubbed)) {
      if (typeof v === "string") {
        envRecord[k] = v;
      }
    }

    let rawWriteStream: NodeJS.WritableStream | null = null;
    if (req.raw_dir) {
      mkdirSync(req.raw_dir, { recursive: true });
      const rawFilePath = join(req.raw_dir, `${sessionId}.ndjson`);
      const stream = createWriteStream(rawFilePath, { flags: "a" });
      stream.on("error", (err) => {
        log.warn(`Failed to write raw stream to ${rawFilePath}:`, err);
      });
      rawWriteStream = stream;
    }

    const proc = spawnSupervisedProcess({
      command: this.options.bin ?? "claude",
      args,
      input: req.prompt,
      cwd: req.cwd,
      env: envRecord,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });

    const allEvents: BackendEvent[] = [];
    const seenDenials = new Set<string>();
    let done = false;
    let waitingConsumers: Array<() => void> = [];
    let killedFor: "timeout" | "cancel" | undefined;

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
            if (rawWriteStream) {
              try {
                rawWriteStream.write(chunk);
              } catch (err) {
                log.warn("Raw stream write error:", err);
              }
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
        log.warn("Error reading NDJSON stream:", err);
      } finally {
        if (rawWriteStream) {
          await new Promise<void>((resolve) => {
            rawWriteStream!.end(() => resolve());
          });
        }
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
        const stderrDetail = harnessStderrDetail(exitResult);
        const crashError: BackendEvent = {
          type: "error",
          kind: "crash",
          message: `Process crashed with exit code ${exitResult.exitCode ?? "null"}${stderrDetail ? `: ${stderrDetail}` : ""}`,
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
      kill: async (reason: "timeout" | "cancel") => {
        killedFor = killedFor ?? reason;
        await proc.kill(reason);
      },
    };
  }
}
