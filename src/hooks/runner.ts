import { type ChildProcess, spawn } from "node:child_process";
import type { Settings } from "../contracts/index.js";
import type {
  HookConfig,
  HookEventName,
  HookMergePayload,
  HookPayload,
  HookResult,
} from "./types.js";

const BLOCKING_GATE_EVENTS = new Set<HookEventName>([
  "PreRun",
  "PostPlan",
  "PreTask",
  "PreMerge",
]);

const MAX_OUTPUT_BYTES = 64 * 1024;

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes("KEY") ||
    upper.includes("TOKEN") ||
    upper.includes("SECRET") ||
    upper.includes("PASSWD") ||
    upper.includes("PASSWORD") ||
    upper.includes("AUTH") ||
    upper.includes("CREDENTIAL") ||
    upper.includes("PRIVATE")
  );
}

function scrubEnvironment(rawEnv: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, val] of Object.entries(rawEnv)) {
    if (val !== undefined && !isSensitiveEnvKey(key)) {
      scrubbed[key] = val;
    }
  }
  if (!scrubbed.PATH && rawEnv.PATH) {
    scrubbed.PATH = rawEnv.PATH;
  }
  return scrubbed;
}

export function executeHookCommand(
  cmd: HookConfig,
  stdinJson: string,
  cwd: string
): Promise<HookResult> {
  return new Promise<HookResult>((resolve) => {
    const startTime = Date.now();
    const timeout_s = cmd.timeout_s ?? 30;
    const timeoutMs = timeout_s * 1000;

    let timed_out = false;
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let settled = false;

    let sigtermTimer: NodeJS.Timeout | null = null;
    let sigkillTimer: NodeJS.Timeout | null = null;

    const env = scrubEnvironment(process.env);

    let child: ChildProcess;
    try {
      child = spawn(cmd.command, {
        shell: true,
        detached: true,
        cwd,
        env,
      });
    } catch (err: any) {
      return resolve({
        command: cmd.command,
        exit_code: 127,
        blocked: false,
        stderr: err?.message ?? "Failed to spawn hook command",
        stdout: "",
        timed_out: false,
        duration_ms: Date.now() - startTime,
      });
    }

    const cleanupTimers = () => {
      if (sigtermTimer) {
        clearTimeout(sigtermTimer);
        sigtermTimer = null;
      }
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
    };

    sigtermTimer = setTimeout(() => {
      timed_out = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      }
      sigkillTimer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }
      }, 500);
    }, timeoutMs);

    if (child.stdin) {
      child.stdin.on("error", () => {});
      try {
        child.stdin.write(stdinJson);
        child.stdin.end();
      } catch {}
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
        if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
          stdoutBuf = stdoutBuf.subarray(stdoutBuf.length - MAX_OUTPUT_BYTES);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf = Buffer.concat([stderrBuf, chunk]);
        if (stderrBuf.length > MAX_OUTPUT_BYTES) {
          stderrBuf = stderrBuf.subarray(stderrBuf.length - MAX_OUTPUT_BYTES);
        }
      });
    }

    child.on("error", (err: any) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve({
        command: cmd.command,
        exit_code: 127,
        blocked: false,
        stderr: err?.message ?? "Hook process error",
        stdout: stdoutBuf.toString("utf8"),
        timed_out: false,
        duration_ms: Date.now() - startTime,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanupTimers();

      const duration_ms = Date.now() - startTime;
      const stdout = stdoutBuf.toString("utf8");
      let stderr = stderrBuf.toString("utf8");

      if (timed_out) {
        resolve({
          command: cmd.command,
          exit_code: null,
          blocked: false,
          stderr: stderr || `Timed out after ${timeout_s}s`,
          stdout,
          timed_out: true,
          duration_ms,
        });
        return;
      }

      const exit_code = code;
      let blocked = false;

      if (exit_code === 0) {
        blocked = false;
      } else if (exit_code === 2) {
        blocked = true;
        if (!stderr.trim()) {
          stderr = "Hook command exited with code 2 but emitted no stderr";
        }
      } else {
        blocked = false;
      }

      resolve({
        command: cmd.command,
        exit_code,
        blocked,
        stderr,
        stdout,
        timed_out: false,
        duration_ms,
      });
    });
  });
}

export class HookRunner {
  constructor(private readonly settings?: Settings) {}

  async runHook(
    event: HookEventName,
    payload: HookPayload | HookMergePayload,
    hooksConfig?: HookConfig[]
  ): Promise<HookResult[]> {
    const configs: HookConfig[] =
      hooksConfig ??
      (this.settings?.hooks?.[event] as HookConfig[] | undefined) ??
      [];

    if (!configs || configs.length === 0) {
      return [];
    }

    const results: HookResult[] = [];
    const stdinJson = JSON.stringify(payload);
    const cwd = payload.cwd || process.cwd();

    for (const config of configs) {
      const res = await executeHookCommand(config, stdinJson, cwd);
      results.push(res);

      if (res.blocked && BLOCKING_GATE_EVENTS.has(event)) {
        break;
      }
    }

    return results;
  }
}

export const HookRunnerImpl = HookRunner;

export function createHookRunner(settings?: Settings): HookRunner {
  return new HookRunner(settings);
}
