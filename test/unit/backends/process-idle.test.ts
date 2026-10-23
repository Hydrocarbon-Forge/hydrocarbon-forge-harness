import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSupervisedProcess } from "../../../src/backends/process.js";

// The no-output idle watchdog (owner, 2026-10-23): a hang detector, not a work limit. A child that writes nothing for
// idleTimeoutMs is killed with reason "timeout"; a child that keeps writing is never killed, however long it runs.

function withCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "process-idle-test-"));
  return fn(cwd).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

describe("Process Supervisor: no-output idle watchdog", () => {
  it("kills a silent child once it has written nothing for idleTimeoutMs, with reason timeout", () =>
    withCwd(async (cwd) => {
      const started = Date.now();
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "setInterval(() => {}, 1 << 30);"],
        cwd,
        idleTimeoutMs: 300,
        gracePeriodMs: 1000,
      });
      const result = await proc.wait();
      const elapsed = Date.now() - started;

      expect(result.killed).toBe(true);
      expect(result.killReason).toBe("timeout");
      expect(result.timedOut).toBe(true);
      // Killed by the watchdog, not by a long wait: well under the 60 s a hung child would otherwise take.
      expect(elapsed).toBeLessThan(20000);
    }));

  it("does not kill a child that keeps writing, even when its total run is longer than idleTimeoutMs", () =>
    withCwd(async (cwd) => {
      // Ten chunks, one every 150 ms: about 1.5 s in all, with gaps well under the 600 ms limit.
      const script =
        "let n = 0; const t = setInterval(() => { process.stdout.write('tick ' + n + '\\n'); if (++n === 10) { clearInterval(t); } }, 150);";
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", script],
        cwd,
        idleTimeoutMs: 600,
      });
      const result = await proc.wait();

      expect(result.exitCode).toBe(0);
      expect(result.killed).toBe(false);
      expect(result.killReason).toBeUndefined();
      expect(result.timedOut).toBe(false);
      expect(result.stdoutTail.trim().split("\n")).toHaveLength(10);
    }));

  it("counts stderr output as activity too", () =>
    withCwd(async (cwd) => {
      const script =
        "let n = 0; const t = setInterval(() => { process.stderr.write('beat ' + n + '\\n'); if (++n === 8) { clearInterval(t); } }, 150);";
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", script],
        cwd,
        idleTimeoutMs: 600,
      });
      const result = await proc.wait();

      expect(result.exitCode).toBe(0);
      expect(result.killed).toBe(false);
    }));

  it("is off when idleTimeoutMs is 0 or unset: a silent child runs to its own end", () =>
    withCwd(async (cwd) => {
      for (const idleTimeoutMs of [0, undefined]) {
        const proc = spawnSupervisedProcess({
          command: "node",
          args: ["-e", "setTimeout(() => {}, 1000);"],
          cwd,
          idleTimeoutMs,
        });
        const result = await proc.wait();

        expect(result.exitCode).toBe(0);
        expect(result.killed).toBe(false);
        expect(result.killReason).toBeUndefined();
      }
    }));

  it("does not fire after the child has exited", () =>
    withCwd(async (cwd) => {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "process.stdout.write('done');"],
        cwd,
        idleTimeoutMs: 200,
      });
      const result = await proc.wait();
      // The child exits at once; the watchdog would fire 200 ms later if it were not cleared on exit.
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(result.exitCode).toBe(0);
      expect(result.killed).toBe(false);
      expect(result.killReason).toBeUndefined();
    }));
});
