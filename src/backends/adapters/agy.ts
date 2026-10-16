import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BackendEvent,
  Capabilities,
  EnvReport,
  HarnessAdapter,
  PricingTable,
  SessionHandle,
  SessionResult,
  SpawnRequest,
  UsageRecord,
} from "../../contracts/index.js";
import { SessionResult as SessionResultSchema } from "../../contracts/index.js";
import { readNdjsonStream } from "../ndjson.js";
import { spawnSupervisedProcess } from "../process.js";
import { AgyNormalizer, type AgyRawEvent } from "../normalize/agy.js";
import { nowIsoTimestamp } from "../../util/index.js";

export interface AgyAdapterOptions {
  bin?: string;
  pricing: PricingTable;
  maxConcurrency?: number;
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
      version_pin: "1.4.0",
      effort: true,
      structured_output: false,
      budget_flag: false,
      cost_reported: false,
      resume: true,
      permission_denial_signal: "stderr",
      sandbox_flag: true,
      native_subagents_headless: false,
      ...(options.maxConcurrency !== undefined
        ? { max_concurrency: options.maxConcurrency }
        : {}),
    };
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
      const pinMatches = version === this.capabilities.version_pin;
      return {
        ok: true,
        version,
        pin_matches: pinMatches,
        problems: pinMatches
          ? []
          : [
              `agy version mismatch: expected ${this.capabilities.version_pin}, found ${version}`,
            ],
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
    const args: string[] = [
      "-p",
      req.prompt,
      "--output-format",
      "stream-json",
      "--model",
      req.model,
    ];

    if (req.effort) {
      let effort = req.effort;
      if (effort === "xhigh" || effort === "max") {
        if (req.model.includes("flash") || req.model.includes("low")) {
          effort = "high";
        }
      }
      args.push("--effort", effort);
    }

    args.push("--mode", "accept-edits");

    if (this.capabilities.sandbox_flag) {
      args.push("--sandbox");
    }

    args.push("--print-timeout", "0s");

    if (req.session?.resume) {
      args.push("--conversation", req.session.resume);
    }

    if (
      this.bin !== "agy" &&
      req.permission?.deny &&
      req.permission.deny.length > 0
    ) {
      args.push("--denial-tool", req.permission.deny[0]);
    }

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
      "FAKE_SCENARIO",
      "AGY_LIVE",
    ];
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
      } catch {
        // Ignore fs error
      }
    };

    const rawSink = (chunk: string | Buffer) => {
      if (savedSessionId) {
        try {
          if (!existsSync(rawDir)) {
            mkdirSync(rawDir, { recursive: true });
          }
          appendFileSync(join(rawDir, `${savedSessionId}.ndjson`), chunk);
        } catch {
          // Ignore fs error
        }
      } else {
        rawChunks.push(chunk);
      }
    };

    const normalizerModel = this.options.pricing.models[req.model]
      ? req.model
      : (Object.keys(this.options.pricing.models)[0] ?? req.model);

    const normalizer = new AgyNormalizer({
      model: normalizerModel,
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
      try {
        for await (const raw of readNdjsonStream<AgyRawEvent>(proc.stdout, {
          rawSink,
          onParseError: () => {
            // Drop torn line fragments
          },
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
      } catch {
        // Stream closed or error
      }
    })();

    const stderrPromise = (async () => {
      try {
        for await (const chunk of proc.stderr) {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          const events = normalizer.scanStderr(text);
          for (const e of events) {
            pushEvent(e);
          }
        }
      } catch {
        // Stderr closed or error
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

      const defaultUsage: UsageRecord = {
        backend: "agy",
        model: normalizerModel,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        cost_source: "computed",
        at: nowIsoTimestamp(),
      };

      const finalUsage = normalizer.getUsage() ?? defaultUsage;

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
