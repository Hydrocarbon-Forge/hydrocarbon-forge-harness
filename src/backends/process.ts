import { spawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { takeTail } from "../util/index.js";

export interface SupervisedProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  gracePeriodMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
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

function isProcessGroupAlive(pgid: number): boolean {
  if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 0) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pgid, 0);
    } else {
      process.kill(-pgid, 0);
    }
    return true;
  } catch (err: any) {
    if (err && err.code === "ESRCH") {
      return false;
    }
    if (err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

export async function terminateProcessGroup(
  pgid: number,
  gracePeriodMs: number = 5000
): Promise<void> {
  if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 0) {
    throw new Error(`Invalid process group ID: ${pgid}`);
  }
  const termSent = killProcessGroup(pgid, "SIGTERM");
  if (!termSent) {
    return;
  }

  const start = Date.now();
  const pollInterval = 50;

  while (Date.now() - start < gracePeriodMs) {
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(pollInterval, Math.max(10, gracePeriodMs - (Date.now() - start)))
      )
    );
    if (!isProcessGroupAlive(pgid)) {
      return;
    }
  }

  // Escalate to SIGKILL
  killProcessGroup(pgid, "SIGKILL");

  // Wait briefly for SIGKILL to reap
  const killStart = Date.now();
  while (isProcessGroupAlive(pgid) && Date.now() - killStart < 3000) {
    await new Promise((r) => setTimeout(r, 20));
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

export function spawnSupervisedProcess(
  options: SupervisedProcessOptions
): SupervisedProcess {
  const env = options.env
    ? { PATH: process.env.PATH, ...options.env }
    : process.env;

  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pid = child.pid;
  if (!pid || pid <= 0) {
    throw new Error(`Failed to spawn child process: invalid PID (${pid})`);
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
