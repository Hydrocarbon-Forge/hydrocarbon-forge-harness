import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import type { SessionHandle } from "../contracts/index.js";
import { redactSecrets, takeTail } from "../util/index.js";

export interface SupervisedProcessOptions {
  command: string;
  args?: string[];
  /** Written to the child's stdin, which is then closed (a headless harness reads its prompt from it). */
  input?: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  gracePeriodMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

/**
 * The harness process could not start at all (E2BIG, ENOENT, EAGAIN ...): no harness output exists.
 * `code` is the system error code when Node reports one synchronously (for example E2BIG).
 */
export class HarnessSpawnError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HarnessSpawnError";
    this.code = code;
  }
}

export interface ProcessExitResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killed: boolean;
  killReason?: "budget" | "timeout" | "cancel";
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface SupervisedProcess {
  readonly pid: number;
  readonly processGroupPid: number;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(
    reason?: "budget" | "timeout" | "cancel",
    gracePeriodMs?: number
  ): Promise<void>;
  wait(): Promise<ProcessExitResult>;
}

/**
 * Binds a run's abort signal to one harness session for the session's lifetime.
 * An abort kills the session with reason "cancel". The returned function removes
 * the listener; callers run it once the session has ended.
 */
/** Bytes of harness stderr kept in an error message. */
const STDERR_DETAIL_MAX_BYTES = 2048;

/**
 * The tail of a finished child's stderr, with secrets masked, for an error
 * message. Empty when the child wrote nothing to stderr.
 */
export function harnessStderrDetail(exitRes: ProcessExitResult): string {
  return takeTail(redactSecrets(exitRes.stderrTail), STDERR_DETAIL_MAX_BYTES).text.trim();
}

export function bindAbort(signal: AbortSignal | undefined, handle: SessionHandle): () => void {
  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    void handle.kill("cancel");
    return () => {};
  }
  const onAbort = () => {
    void handle.kill("cancel");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

export function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals = "SIGTERM"
): boolean {
  if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 0) {
    throw new Error(`Invalid process group ID: ${pgid}`);
  }
  try {
    if (process.platform === "win32") {
      process.kill(pgid, signal);
    } else {
      process.kill(-pgid, signal);
    }
    return true;
  } catch (err: any) {
    if (err && (err.code === "ESRCH" || err.message?.includes("ESRCH"))) {
      return false;
    }
    throw err;
  }
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private maxBytes?: number;
  private truncated = false;

  constructor(maxBytes?: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
    if (this.maxBytes !== undefined) {
      if (this.totalBytes > this.maxBytes) {
        this.truncated = true;
      }
      while (
        this.chunks.length > 1 &&
        this.totalBytes - this.chunks[0].byteLength >= this.maxBytes
      ) {
        this.totalBytes -= this.chunks[0].byteLength;
        this.chunks.shift();
      }
    }
  }

  getResult(): { text: string; truncated: boolean } {
    if (this.chunks.length === 0) {
      return { text: "", truncated: false };
    }
    const combined = Buffer.concat(this.chunks).toString("utf8");
    if (this.maxBytes !== undefined) {
      if (this.maxBytes <= 0) {
        return { text: "", truncated: this.totalBytes > 0 };
      }
      const res = takeTail(combined, this.maxBytes);
      return { text: res.text, truncated: this.truncated || res.truncated };
    }
    return { text: combined, truncated: false };
  }
}

function createStreamBridge(
  childStream: Readable | null,
  tailBuffer: TailBuffer
): PassThrough {
  const pt = new PassThrough();
  let hasConsumer = false;

  pt.on("newListener", (event) => {
    if (event === "data" || event === "readable") {
      hasConsumer = true;
    }
  });

  pt.on("removeListener", () => {
    if (pt.listenerCount("data") === 0 && pt.listenerCount("readable") === 0) {
      hasConsumer = false;
      if (childStream?.isPaused?.()) {
        childStream?.resume?.();
      }
    }
  });

  pt.on("error", (err: any) => {
    if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_PREMATURE_CLOSE") {
      return;
    }
  });

  if (childStream) {
    childStream.on("data", (chunk: Buffer) => {
      tailBuffer.push(chunk);

      if (!hasConsumer) {
        if (pt.writableLength < pt.writableHighWaterMark) {
          pt.write(chunk);
        }
        return;
      }

      const ok = pt.write(chunk);
      if (!ok) {
        childStream.pause();
        pt.once("drain", () => {
          childStream.resume();
        });
      }
    });

    childStream.on("end", () => {
      pt.end();
    });

    childStream.on("error", (err: any) => {
      if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        return;
      }
      pt.destroy(err);
    });
  } else {
    pt.end();
  }

  return pt;
}

/** True when `command` names an executable file: a path that exists, or a name found in a PATH directory. */
function isExecutableOnPath(command: string, pathValue: string | undefined): boolean {
  if (command.includes(path.sep)) {
    try {
      accessSync(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of (pathValue ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    try {
      accessSync(path.join(dir, command), fsConstants.X_OK);
      return true;
    } catch {
      // Not in this directory; keep looking.
    }
  }
  return false;
}

export function spawnSupervisedProcess(
  options: SupervisedProcessOptions
): SupervisedProcess {
  let env: NodeJS.ProcessEnv = options.env
    ? { PATH: process.env.PATH, ...options.env }
    : process.env;
  // Node's `cwd` option does not update PWD; tools that resolve their project from PWD
  // (opencode) need it to match the directory the child actually runs in.
  if (options.cwd) {
    env = { ...env, PWD: path.resolve(options.cwd) };
  }

  let child;
  try {
    child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (err: any) {
    throw new HarnessSpawnError(`could not start ${options.command}: ${err?.message ?? String(err)}`, err?.code);
  }

  const pid = child.pid;
  if (!pid || pid <= 0) {
    // Node reports a missing binary asynchronously. The listener keeps that event from crashing the process.
    child.on("error", () => {});
    // A binary that is not on PATH is named as such, with its code, so the spawn is not retried (R13.1).
    if (!isExecutableOnPath(options.command, env.PATH)) {
      throw new HarnessSpawnError(`${options.command} was not found on PATH`, "ENOENT");
    }
    throw new HarnessSpawnError(`could not start ${options.command}: the system did not start the process`);
  }
  if (options.input !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(options.input, "utf8");
  }
  const processGroupPid = pid;

  const startTime = Date.now();
  let timedOut = false;
  let killed = false;
  let killReason: "budget" | "timeout" | "cancel" | undefined;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let killPromise: Promise<void> | null = null;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let exited = false;

  const stdoutBuffer = new TailBuffer(options.maxStdoutBytes);
  const stderrBuffer = new TailBuffer(options.maxStderrBytes);

  const stdoutStream = createStreamBridge(child.stdout, stdoutBuffer);
  const stderrStream = createStreamBridge(child.stderr, stderrBuffer);

  const exitPromise = new Promise<void>((resolve) => {
    child.on("close", (code, sig) => {
      exited = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      exitCode = code;
      signal = sig as NodeJS.Signals | null;
      if (sig !== null) {
        killed = true;
      }
      resolve();
    });

    child.on("error", () => {
      exited = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      resolve();
    });
  });

  const kill = async (
    reason: "budget" | "timeout" | "cancel" = "cancel",
    gracePeriodMsOverride?: number
  ): Promise<void> => {
    if (exited) {
      return;
    }
    if (killPromise) {
      return killPromise;
    }
    killed = true;
    killReason = killReason ?? reason;
    const grace = gracePeriodMsOverride ?? options.gracePeriodMs ?? 5000;

    killPromise = (async () => {
      killProcessGroup(processGroupPid, "SIGTERM");

      let timerId: NodeJS.Timeout | null = null;
      const graceTimeoutPromise = new Promise<"grace_timeout">((resolve) => {
        timerId = setTimeout(() => resolve("grace_timeout"), grace);
      });

      const outcome = await Promise.race([
        exitPromise.then(() => "exited" as const),
        graceTimeoutPromise,
      ]);

      if (timerId) {
        clearTimeout(timerId);
      }

      if (outcome === "grace_timeout" && !exited) {
        killProcessGroup(processGroupPid, "SIGKILL");
      }

      await exitPromise;
    })();

    return killPromise;
  };

  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (!exited) {
        timedOut = true;
        kill("timeout", options.gracePeriodMs);
      }
    }, options.timeoutMs);
  }

  const wait = async (): Promise<ProcessExitResult> => {
    await exitPromise;
    const durationMs = Date.now() - startTime;
    const stdoutRes = stdoutBuffer.getResult();
    const stderrRes = stderrBuffer.getResult();

    return {
      exitCode,
      signal,
      timedOut,
      killed,
      killReason,
      stdoutTail: stdoutRes.text,
      stderrTail: stderrRes.text,
      stdoutTruncated: stdoutRes.truncated,
      stderrTruncated: stderrRes.truncated,
      durationMs,
    };
  };

  return {
    pid,
    processGroupPid,
    stdout: stdoutStream,
    stderr: stderrStream,
    kill,
    wait,
  };
}
