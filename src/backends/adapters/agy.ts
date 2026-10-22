import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  BackendEvent,
  Capabilities,
  EnvReport,
  HarnessAdapter,
  PricingTable,
  SessionHandle,
  SessionResult,
  SpawnRequest,
} from "../../contracts/index.js";
import { ModelInfo, SessionResult as SessionResultSchema } from "../../contracts/index.js";
import { readNdjsonStream } from "../ndjson.js";
import { spawnSupervisedProcess } from "../process.js";
import { AgyNormalizer, type AgyRawEvent } from "../normalize/agy.js";
import { log } from "../../util/log.js";

export interface AgyAdapterOptions {
  bin?: string;
  pricing: PricingTable;
  maxConcurrency?: number;
  versionPin?: string;
}

const execFileAsync = promisify(execFile);

/** Timeout for the `agy models` call, in milliseconds. */
const MODELS_TIMEOUT_MS = 30000;

/** Effort slugs agy 1.4.0 accepts (S3: no shipped slug accepts xhigh or max). */
const AGY_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * The env names passed to the agy process. Harness scenario variables are not part
 * of this list: the test dialect reads its scenario from the child environment, so
 * a test must pass it through the env option of SpawnRequest instead of relying on
 * inheritance from the test process.
 */
const ALLOWED_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];

/**
 * Combines the system rules with the task prompt. agy has no verified
 * system-prompt flag (S3), so both parts travel in the `-p` argument.
 */
function buildPrompt(req: SpawnRequest): string {
  if (!req.system_append) {
    return req.prompt;
  }
  return `SYSTEM RULES\n${req.system_append}\n\nTASK\n${req.prompt}`;
}

export function buildAgyArgv(req: SpawnRequest): string[] {
  const argv: string[] = [
    "-p",
    buildPrompt(req),
    "--output-format",
    "stream-json",
    "--model",
    req.model,
  ];

  if (req.effort) {
    if (AGY_EFFORTS.has(req.effort)) {
      argv.push("--effort", req.effort);
    } else {
      log.warn(`agy: effort ${req.effort} is not supported by agy 1.4.0; omitted`);
    }
  }

  argv.push("--mode", "accept-edits");

  // Owner decision 2026-10-19: all harnesses run with permissions bypassed.
  argv.push("--dangerously-skip-permissions");

  // Verified on the installed binary with `agy --help` on 2026-10-18 that the
  // flag exists; WP Notes keep it and it is passed explicitly as 0s so a headless
  // run never waits on an interactive prompt (documented default is 5m per S3).
  argv.push("--print-timeout", "0s");

  // S3: `--conversation <id>` resumes the same conversation and step numbering.
  if (req.session?.resume) {
    argv.push("--conversation", req.session.resume);
  }

  return argv;
}

/**
 * Parses the stdout of `agy models` (verified on the installed binary 2026-10-18):
 * the progress line `Fetching available models...` plus one `id<TAB>display` row
 * per model. Rows are the only lines read; Windows line endings are stripped. A
 * slug ending in -low, -medium or -high gets that tier as its only effort.
 */
export function parseAgyModels(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\t/.test(line)) {
      continue;
    }
    const [id, display] = line.split("\t");
    const tierMatch = id.match(/-(low|medium|high)$/);
    const info: ModelInfo = {
      id,
      efforts: tierMatch ? [tierMatch[1]] : [],
      source: "cli",
    };
    if (display !== "") {
      info.display = display;
    }
    models.push(ModelInfo.parse(info));
  }
  return models;
}

function findExecutable(bin: string): string | null {
  if (isAbsolute(bin)) {
    return existsSync(bin) ? bin : null;
  }
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (existsSync(full)) {
      return full;
    }
  }
  return null;
}

export class AgyAdapter implements HarnessAdapter {
  readonly capabilities: Capabilities;
  private readonly bin: string;
  private readonly options: AgyAdapterOptions;

  constructor(options: AgyAdapterOptions) {
    this.options = options;
    this.bin = options.bin ?? "agy";
    this.capabilities = {
      name: "agy",
      version_pin: "1.4.2",
      effort: true,
      structured_output: false,
      budget_flag: false,
      cost_reported: false,
      resume: true,
      // S3 (verified locally 2026-10-16): a headless agy run cannot prompt for a
      // permission. Since the 2026-10-19 bypass decision agy runs with
      // --dangerously-skip-permissions, so auto-denial should not occur; the
      // normalizer still parses it if it does, via the stderr line
      // `jetski: no output produced ... permission ... auto-denied` and
      // `result.denied_actions`. Exit code is still 0, so the signal is stderr.
      permission_denial_signal: "stderr",
      // S3: the sandbox flag is OS isolation (Linux namespaces), not a permission
      // grant, and it is off by default. It grants nothing to the adapter, so the
      // capability is false and the flag is never passed.
      sandbox_flag: false,
      native_subagents_headless: false,
      ...(options.maxConcurrency !== undefined
        ? { max_concurrency: options.maxConcurrency }
        : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const exe = findExecutable(this.bin);
    if (!exe) {
      throw new Error(`agy models failed: ${this.bin} not found`);
    }
    try {
      const { stdout } = await execFileAsync(exe, ["models"], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: MODELS_TIMEOUT_MS,
      });
      return parseAgyModels(stdout);
    } catch (err) {
      throw new Error(`agy models failed: ${(err as Error).message}`);
    }
  }

  async validateEnvironment(): Promise<EnvReport> {
    try {
      if (!findExecutable(this.bin)) {
        return {
          ok: false,
          pin_matches: false,
          problems: ["agy binary not found or failed to execute"],
        };
      }

      const proc = spawnSupervisedProcess({
        command: this.bin,
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 5000,
      });

      const res = await proc.wait();
      if (res.exitCode !== 0) {
        return {
          ok: false,
          pin_matches: false,
          problems: ["agy binary not found or failed to execute"],
        };
      }

      const version = res.stdoutTail.trim();
      const pin = this.options.versionPin ?? this.capabilities.version_pin;
      const pinMatches = version === pin;
      return {
        ok: true,
        version,
        pin_matches: pinMatches,
        problems: pinMatches
          ? []
          : [`agy version mismatch: expected ${pin}, found ${version}`],
      };
    } catch {
      return {
        ok: false,
        pin_matches: false,
        problems: ["agy binary not found or failed to execute"],
      };
    }
  }

  spawn(req: SpawnRequest): SessionHandle {
    const args = buildAgyArgv(req);

    const env: Record<string, string> = {};
    for (const key of ALLOWED_ENV_VARS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }
    if (req.env) {
      for (const [k, v] of Object.entries(req.env)) {
        env[k] = v;
      }
    }

    const proc = spawnSupervisedProcess({
      command: this.bin,
      args,
      cwd: req.cwd,
      env,
      timeoutMs: req.budget.timeout_ms,
    });

    const rawDir = join(req.cwd, "raw");
    const rawChunks: (string | Buffer)[] = [];
    let savedSessionId = req.session?.resume ?? req.session?.id;

    const flushRaw = (sid: string) => {
      if (rawChunks.length === 0) return;
      try {
        if (!existsSync(rawDir)) {
          mkdirSync(rawDir, { recursive: true });
        }
        const rawFile = join(rawDir, `${sid}.ndjson`);
        for (const chunk of rawChunks) {
          appendFileSync(rawFile, chunk);
        }
        rawChunks.length = 0;
      } catch (err: any) {
        log.warn(`agy: could not write raw stream for ${sid}: ${err.message}`);
      }
    };

    const rawSink = (chunk: string | Buffer) => {
      if (savedSessionId) {
        try {
          if (!existsSync(rawDir)) {
            mkdirSync(rawDir, { recursive: true });
          }
          appendFileSync(join(rawDir, `${savedSessionId}.ndjson`), chunk);
        } catch (err: any) {
          log.warn(
            `agy: could not append raw stream for ${savedSessionId}: ${err.message}`
          );
        }
      } else {
        rawChunks.push(chunk);
      }
    };

    const normalizer = new AgyNormalizer({
      // The record's model is the requested model (R2.5). The pricing lookup does
      // not substitute another model: an unpriced model keeps cost_source unknown
      // and the stream continues.
      model: req.model,
      pricing: this.options.pricing,
    });

    const recordedEvents: BackendEvent[] = [];
    let processFinished = false;
    const listeners = new Set<() => void>();
    let observedResultEvent: (BackendEvent & { type: "session.result" }) | null =
      null;

    const notifyListeners = () => {
      for (const listener of listeners) {
        listener();
      }
      listeners.clear();
    };

    const pushEvent = (evt: BackendEvent) => {
      if (evt.type === "session.result") {
        observedResultEvent = evt;
      }
      recordedEvents.push(evt);
      notifyListeners();
    };

    const stdoutPromise = (async () => {
      for await (const raw of readNdjsonStream<AgyRawEvent>(proc.stdout, {
        rawSink,
      })) {
        const convId = normalizer.getConversationId();
        if (convId && !savedSessionId) {
          savedSessionId = convId;
          flushRaw(convId);
        }
        const events = normalizer.normalizeEvent(raw);
        for (const e of events) {
          pushEvent(e);
        }
      }
    })();

    const stderrPromise = (async () => {
      for await (const chunk of proc.stderr) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const events = normalizer.scanStderr(text);
        for (const e of events) {
          pushEvent(e);
        }
      }
    })();

    const completionPromise = (async () => {
      const exitRes = await proc.wait();
      await Promise.all([stdoutPromise, stderrPromise]);

      const convId = normalizer.getConversationId();
      if (convId && !savedSessionId) {
        savedSessionId = convId;
      }
      if (!savedSessionId) {
        savedSessionId = randomUUID();
      }
      flushRaw(savedSessionId);

      const finalizeEvents = normalizer.finalize(exitRes.exitCode);
      for (const e of finalizeEvents) {
        pushEvent(e);
      }

      processFinished = true;
      notifyListeners();
      return exitRes;
    })();

    async function* generateEvents(): AsyncIterable<BackendEvent> {
      let idx = 0;
      while (true) {
        while (idx < recordedEvents.length) {
          yield recordedEvents[idx++];
        }
        if (processFinished) {
          break;
        }
        await new Promise<void>((resolve) => {
          listeners.add(resolve);
        });
      }
    }

    const kill = async (
      reason: "budget" | "timeout" | "cancel"
    ): Promise<void> => {
      await proc.kill(reason);
    };

    const result = async (): Promise<SessionResult> => {
      const exitRes = await completionPromise;

      const denials = normalizer.getDenials();
      const ok =
        exitRes.exitCode === 0 &&
        !exitRes.killed &&
        !exitRes.timedOut &&
        denials.length === 0 &&
        (observedResultEvent ? observedResultEvent.ok : true);

      const finalUsage = normalizer.getUsage();

      const res: SessionResult = {
        ok,
        session_id: savedSessionId!,
        final_text:
          observedResultEvent?.final_text ?? normalizer.getFinalText() ?? "",
        usage: finalUsage,
        exit_code: exitRes.exitCode,
        denials,
      };

      if (exitRes.killReason) {
        res.killed_for = exitRes.killReason;
      }

      return SessionResultSchema.parse(res);
    };

    return {
      pid: proc.pid,
      events: generateEvents(),
      kill,
      result,
    };
  }
}
