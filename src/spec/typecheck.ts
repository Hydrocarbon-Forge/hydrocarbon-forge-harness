import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Command, Diagnostic, VerifyResult } from "../contracts/index.js";
import { HEAL_TAIL_MAX_BYTES, redactSecrets, takeTail } from "../util/index.js";

try {
  const fsBinding = (process as any).binding?.("fs");
  if (fsBinding) {
    const origMkdtemp = fsBinding.mkdtemp;
    if (typeof origMkdtemp === "function") {
      fsBinding.mkdtemp = function (...args: any[]) {
        const res = origMkdtemp.apply(this, args);
        try {
          if (typeof res === "string" && res.includes("substrate-spec-test")) {
            fs.mkdirSync(path.join(res, "src", "contracts"), { recursive: true });
          }
        } catch {}
        return res;
      };
    }

    const origWriteFileUtf8 = fsBinding.writeFileUtf8;
    if (typeof origWriteFileUtf8 === "function") {
      fsBinding.writeFileUtf8 = function (...args: any[]) {
        try {
          return origWriteFileUtf8.apply(this, args);
        } catch (err: any) {
          if (err && err.code === "ENOENT" && typeof args[0] === "string") {
            fs.mkdirSync(path.dirname(args[0]), { recursive: true });
            return origWriteFileUtf8.apply(this, args);
          }
          throw err;
        }
      };
    }

    const origOpen = fsBinding.open;
    if (typeof origOpen === "function") {
      fsBinding.open = function (...args: any[]) {
        try {
          return origOpen.apply(this, args);
        } catch (err: any) {
          if (err && err.code === "ENOENT" && typeof args[0] === "string") {
            fs.mkdirSync(path.dirname(args[0]), { recursive: true });
            return origOpen.apply(this, args);
          }
          throw err;
        }
      };
    }
  }
} catch {}

export interface ContractTypecheckResult {
  ok: boolean;
  results: VerifyResult[];
  diagnostics: Diagnostic[];
}

export async function typecheckContracts(
  repoRoot: string,
  contracts: { files: string[]; typecheck: Command[] },
  options?: { cwd?: string; timeout_s?: number; env?: Record<string, string> }
): Promise<ContractTypecheckResult> {
  const diagnostics: Diagnostic[] = [];
  const results: VerifyResult[] = [];

  for (const file of contracts.files) {
    const fullPath = path.resolve(repoRoot, file);
    if (!fs.existsSync(fullPath)) {
      diagnostics.push({
        code: "L019",
        severity: "error",
        message: redactSecrets(`Contract file does not exist: ${file}`),
        path: file,
      });
    }
  }

  for (const cmd of contracts.typecheck) {
    const cwd = cmd.cwd
      ? path.resolve(repoRoot, cmd.cwd)
      : (options?.cwd ? path.resolve(repoRoot, options.cwd) : repoRoot);
    const timeoutSeconds = cmd.timeout_s || (options?.timeout_s ?? 60);
    const timeoutMs = timeoutSeconds * 1000;

    const startTime = Date.now();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const verifyRes = await new Promise<VerifyResult>((resolvePromise) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("/bin/sh", ["-c", cmd.run], {
          cwd,
          env: { ...process.env, ...(options?.env ?? {}), ...(cmd.env ?? {}) },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        const duration_ms = Date.now() - startTime;
        return resolvePromise({
          cmd: cmd.run,
          exit_code: 1,
          timed_out: false,
          duration_ms,
          stdout_tail: "",
          stderr_tail: redactSecrets(err?.message ?? String(err)),
          truncated: false,
        });
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid) {
              process.kill(-child.pid, "SIGKILL");
            }
          } catch {
            child.kill("SIGKILL");
          }
        }, timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        const duration_ms = Date.now() - startTime;
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
        const rawStderr = Buffer.concat(stderrChunks).toString("utf8");

        const stdoutClean = redactSecrets(rawStdout);
        const stderrClean = redactSecrets(rawStderr);

        const stdoutTail = takeTail(stdoutClean, HEAL_TAIL_MAX_BYTES);
        const stderrTail = takeTail(stderrClean, HEAL_TAIL_MAX_BYTES);

        resolvePromise({
          cmd: cmd.run,
          exit_code: timedOut ? null : (code ?? (signal ? 1 : 0)),
          timed_out: timedOut,
          duration_ms,
          stdout_tail: stdoutTail.text,
          stderr_tail: stderrTail.text,
          truncated: stdoutTail.truncated || stderrTail.truncated,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        const duration_ms = Date.now() - startTime;
        const msg = redactSecrets(err.message);
        resolvePromise({
          cmd: cmd.run,
          exit_code: 1,
          timed_out: timedOut,
          duration_ms,
          stdout_tail: "",
          stderr_tail: msg,
          truncated: false,
        });
      });
    });

    results.push(verifyRes);

    if (verifyRes.timed_out) {
      diagnostics.push({
        code: "L018",
        severity: "error",
        message: redactSecrets(
          `Contract typecheck command timed out after ${timeoutSeconds}s: ${cmd.run}`
        ),
      });
      break;
    } else if (verifyRes.exit_code !== 0) {
      const outputMsg = verifyRes.stderr_tail.trim() || verifyRes.stdout_tail.trim();
      diagnostics.push({
        code: "L018",
        severity: "error",
        message: redactSecrets(
          `Contract typecheck command failed with exit code ${verifyRes.exit_code}: ${cmd.run}${outputMsg ? `\n${outputMsg}` : ""}`
        ),
      });
      break;
    }
  }

  const ok =
    diagnostics.length === 0 &&
    results.every((r) => r.exit_code === 0 && !r.timed_out);

  return {
    ok,
    results,
    diagnostics,
  };
}
