import { spawn } from "node:child_process";
import type { Command, VerifyResult } from "../contracts/index.js";
import { takeTail } from "../util/index.js";
import { BwrapSandbox } from "./sandbox.js";

export interface VerifyRunnerOptions {
  cwd: string;
  commands: Command[];
  sandbox?: boolean;
  network?: "deny" | "allow";
  env?: Record<string, string>;
  maxTailBytes?: number;
}

export interface VerifyRunner {
  runVerify(options: VerifyRunnerOptions): Promise<VerifyResult[]>;
  isAllPassed(results: VerifyResult[]): boolean;
}

export class VerifyRunnerImpl implements VerifyRunner {
  async runVerify(options: VerifyRunnerOptions): Promise<VerifyResult[]> {
    const results: VerifyResult[] = [];
    const maxTailBytes = options.maxTailBytes ?? 8192;
    const sandboxHelper = new BwrapSandbox();
    const sandboxAvailable =
      process.platform === "linux" && (await sandboxHelper.isAvailable());

    for (const cmd of options.commands) {
      const startTime = Date.now();
      const useSandbox = options.sandbox === true && sandboxAvailable;

      let exe = "/bin/bash";
      let args = ["-c", cmd.run];

      if (useSandbox) {
        const wrapped = sandboxHelper.wrapCommand(["/bin/bash", "-c", cmd.run], {
          worktreePath: options.cwd,
          network: options.network ?? "deny",
        });
        exe = wrapped[0];
        args = wrapped.slice(1);
      }

      const baseEnv = sandboxHelper.scrubEnvironment(process.env);
      const execEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...(options.env ?? {}),
        ...(cmd.env ?? {}),
      };

      const child = spawn(exe, args, {
        cwd: cmd.cwd ?? options.cwd,
        env: execEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;

      if (cmd.timeout_s > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid) {
              process.kill(-child.pid, "SIGKILL");
            }
          } catch {
            // Process might have already exited
          }
        }, cmd.timeout_s * 1000);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      await new Promise<void>((resolve) => {
        child.on("close", () => {
          if (timer) clearTimeout(timer);
          resolve();
        });
        child.on("error", (err) => {
          if (timer) clearTimeout(timer);
          stderr += `\n${err.message}`;
          resolve();
        });
      });

      const duration_ms = Date.now() - startTime;
      const stdoutCap = takeTail(stdout, maxTailBytes);
      const stderrCap = takeTail(stderr, maxTailBytes);
      const truncated = stdoutCap.truncated || stderrCap.truncated;

      results.push({
        cmd: cmd.run,
        exit_code: timedOut ? null : child.exitCode,
        timed_out: timedOut,
        duration_ms,
        stdout_tail: stdoutCap.text,
        stderr_tail: stderrCap.text,
        truncated,
      });
    }

    return results;
  }

  isAllPassed(results: VerifyResult[]): boolean {
    if (!results || results.length === 0) {
      return false;
    }
    return results.every((r) => r.exit_code === 0 && !r.timed_out);
  }
}

export const VerifyRunner = VerifyRunnerImpl;
export const verifyRunner = new VerifyRunnerImpl();
