import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  spawnSupervisedProcess,
  killProcessGroup,
} from "../../../src/backends/process.js";
import {
  readNdjsonLines,
  readNdjsonStream,
  parseNdjsonLine,
  ProtocolError,
} from "../../../src/backends/ndjson.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "process-test-"));
}

describe("Process Supervisor: basic execution and exit outcomes", () => {
  it("spawns process with detached: true and captures stdout/stderr with exitCode 0", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "process.stdout.write('hello-out'); process.stderr.write('hello-err');"],
        cwd,
      });

      expect(proc.pid).toBeGreaterThan(0);
      expect(proc.processGroupPid).toBe(proc.pid);

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(false);
      expect(result.stdoutTail).toBe("hello-out");
      expect(result.stderrTail).toBe("hello-err");
      expect(result.stdoutTruncated).toBe(false);
      expect(result.stderrTruncated).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("captures non-zero exit codes correctly", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "process.stderr.write('fatal failure'); process.exit(42);"],
        cwd,
      });

      const result = await proc.wait();
      expect(result.exitCode).toBe(42);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.killed).toBe(false);
      expect(result.stderrTail).toContain("fatal failure");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("Process Supervisor: tail capping", () => {
  it("caps stdout tail and marks stdoutTruncated: true when exceeding maxStdoutBytes", async () => {
    const cwd = makeTmpDir();
    try {
      // Produce 20000 bytes
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "for(let i=0; i<1000; i++) process.stdout.write('A'.repeat(20));"],
        cwd,
        maxStdoutBytes: 500,
      });

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stdoutTruncated).toBe(true);
      expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(500);
      expect(result.stdoutTail.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("caps stderr tail and marks stderrTruncated: true when exceeding maxStderrBytes", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "for(let i=0; i<500; i++) process.stderr.write('E'.repeat(30));"],
        cwd,
        maxStderrBytes: 300,
      });

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stderrTruncated).toBe(true);
      expect(Buffer.byteLength(result.stderrTail)).toBeLessThanOrEqual(300);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("handles zero-byte stdout/stderr with empty string and untruncated flags", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "/* silent exit */"],
        cwd,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
      });

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stdoutTail).toBe("");
      expect(result.stderrTail).toBe("");
      expect(result.stdoutTruncated).toBe(false);
      expect(result.stderrTruncated).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("Process Supervisor: timeout and staged escalation", () => {
  it("kills process group and records timedOut: true when exceeding timeoutMs", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd,
        timeoutMs: 200,
        gracePeriodMs: 300,
      });

      const result = await proc.wait();
      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
      expect(result.killReason).toBe("timeout");
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBeTruthy();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("escalates from SIGTERM to SIGKILL when process ignores SIGTERM", async () => {
    const cwd = makeTmpDir();
    try {
      // Process traps SIGTERM and ignores it
      const proc = spawnSupervisedProcess({
        command: "node",
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        cwd,
        gracePeriodMs: 150,
      });

      await new Promise((r) => setTimeout(r, 100));
      await proc.kill("cancel", 150);

      const result = await proc.wait();
      expect(result.killed).toBe(true);
      expect(result.killReason).toBe("cancel");
      expect(result.signal).toBe("SIGKILL");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("handles explicit kill with reason 'timeout'", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd,
      });

      await new Promise((r) => setTimeout(r, 50));
      await proc.kill("timeout");

      const result = await proc.wait();
      expect(result.killed).toBe(true);
      expect(result.killReason).toBe("timeout");
      expect(result.timedOut).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent when calling kill multiple times", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd,
      });

      await new Promise((r) => setTimeout(r, 50));

      const p1 = proc.kill("cancel");
      const p2 = proc.kill("cancel");
      await Promise.all([p1, p2]);

      // Calling kill after exit should also be safe
      await proc.kill("cancel");

      const result = await proc.wait();
      expect(result.killed).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("Process Supervisor: process group management and guards", () => {
  it("guards against invalid PGID (0 or negative) by throwing", () => {
    expect(() => killProcessGroup(0)).toThrow(/Invalid process group ID/);
    expect(() => killProcessGroup(-1)).toThrow(/Invalid process group ID/);
    expect(() => killProcessGroup(NaN as any)).toThrow(/Invalid process group ID/);
  });

  it("returns false cleanly without throwing when process already exited (ESRCH)", () => {
    // 999999 is very unlikely to be an active process group
    const killed = killProcessGroup(999999);
    expect(killed).toBe(false);
  });

  it("terminates grandchild processes in the process group", async () => {
    const cwd = makeTmpDir();
    try {
      const script = `
        const { spawn } = require('node:child_process');
        const child = spawn('node', ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
        process.stdout.write(String(child.pid));
        setInterval(() => {}, 1000);
      `;
      writeFileSync(join(cwd, "parent.js"), script, "utf8");

      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["parent.js"],
        cwd,
      });

      let grandchildPidStr = "";
      for await (const chunk of proc.stdout) {
        grandchildPidStr += chunk.toString("utf8");
        if (grandchildPidStr.length > 0) break;
      }
      const grandchildPid = parseInt(grandchildPidStr.trim(), 10);
      expect(grandchildPid).toBeGreaterThan(0);

      // Kill the parent's process group
      await proc.kill("cancel");
      await proc.wait();

      // Check if grandchild is dead
      await new Promise((r) => setTimeout(r, 100));
      let grandchildAlive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch (err: any) {
        if (err.code === "ESRCH") {
          grandchildAlive = false;
        }
      }
      expect(grandchildAlive).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("killProcessGroup sends SIGTERM to a process group standalone", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd,
      });

      expect(proc.processGroupPid).toBeGreaterThan(0);
      expect(killProcessGroup(proc.processGroupPid, "SIGTERM")).toBe(true);

      const result = await proc.wait();
      expect(result.signal).toBeTruthy();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("Process Supervisor: streaming and backpressure", () => {
  it("streams output chunks to stdout stream with backpressure support", async () => {
    const cwd = makeTmpDir();
    try {
      const proc = spawnSupervisedProcess({
        command: "node",
        args: ["-e", "for(let i=0; i<5; i++) console.log('line-' + i);"],
        cwd,
      });

      let received = "";
      for await (const chunk of proc.stdout) {
        received += chunk.toString("utf8");
      }

      expect(received).toContain("line-0");
      expect(received).toContain("line-4");

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not deadlock or block child process when no consumer is reading stdout", async () => {
    const cwd = makeTmpDir();
    try {
      // High volume output (1 MB) without consumer attached to stdout
      const proc = spawnSupervisedProcess({
        command: "node",
        args: [
          "-e",
          "for(let i=0; i<10000; i++) process.stdout.write('X'.repeat(100));",
        ],
        cwd,
        maxStdoutBytes: 1024,
      });

      const result = await proc.wait();
      expect(result.exitCode).toBe(0);
      expect(result.stdoutTruncated).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("NDJSON Reader & Serializer", () => {
  it("parseNdjsonLine parses valid JSON and rejects empty/invalid lines with ProtocolError", () => {
    expect(parseNdjsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseNdjsonLine("  [1, 2, 3]  ")).toEqual([1, 2, 3]);

    expect(() => parseNdjsonLine("")).toThrow(ProtocolError);
    expect(() => parseNdjsonLine("   \n")).toThrow(ProtocolError);
    expect(() => parseNdjsonLine("{not valid json}")).toThrow(ProtocolError);
  });

  it("readNdjsonLines splits discrete lines across chunks and handles CRLF", async () => {
    const stream = Readable.from([
      "line1\r\nline2\nli",
      "ne3\n\n   \nline4",
    ]);

    const lines: string[] = [];
    for await (const line of readNdjsonLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["line1", "line2", "line3", "line4"]);
  });

  it("readNdjsonLines forwards raw chunks to rawSink callback", async () => {
    const chunks: string[] = [];
    const stream = Readable.from(["foo\n", "bar\n"]);

    const lines: string[] = [];
    for await (const line of readNdjsonLines(stream, {
      rawSink: (c) => chunks.push(c.toString("utf8")),
    })) {
      lines.push(line);
    }

    expect(lines).toEqual(["foo", "bar"]);
    expect(chunks).toEqual(["foo\n", "bar\n"]);
  });

  it("readNdjsonLines raises ProtocolError when line exceeds maxLineLength without newline", async () => {
    const stream = Readable.from(["12345", "67890", "more_data"]);

    const reader = readNdjsonLines(stream, { maxLineLength: 10 });
    await expect(async () => {
      for await (const _ of reader) {
        // should fail
      }
    }).rejects.toThrow(ProtocolError);
  });

  it("readNdjsonStream parses stream of JSON objects", async () => {
    const stream = Readable.from([
      '{"msg":"first"}\n{"msg":',
      '"second"}\n{"msg":"third"}\n',
    ]);

    const events: Array<{ msg: string }> = [];
    for await (const item of readNdjsonStream<{ msg: string }>(stream)) {
      events.push(item);
    }

    expect(events).toEqual([
      { msg: "first" },
      { msg: "second" },
      { msg: "third" },
    ]);
  });

  it("readNdjsonStream calls onParseError when provided for invalid JSON", async () => {
    const errors: Array<{ error: Error; line: string }> = [];
    const stream = Readable.from(['{"valid":true}\n', "not-json\n", '{"valid":false}\n']);

    const events: any[] = [];
    for await (const item of readNdjsonStream(stream, {
      onParseError: (error, line) => errors.push({ error, line }),
    })) {
      events.push(item);
    }

    expect(events).toEqual([{ valid: true }, { valid: false }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe("not-json");
  });

  it("readNdjsonStream throws ProtocolError on invalid JSON when onParseError is omitted", async () => {
    const stream = Readable.from(['{"ok":1}\n', "corrupt\n"]);

    await expect(async () => {
      for await (const _ of readNdjsonStream(stream)) {
        // throws on corrupt
      }
    }).rejects.toThrow(ProtocolError);
  });
});

describe("Process Supervisor: working directory and PWD", () => {
  const printEnv = `process.stdout.write(JSON.stringify({ PWD: process.env.PWD ?? null, FOO: process.env.FOO ?? null, cwd: process.cwd() }))`;

  async function runEnvProbe(options: {
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<{ PWD: string | null; FOO: string | null; cwd: string }> {
    const proc = spawnSupervisedProcess({
      command: process.execPath,
      args: ["-e", printEnv],
      cwd: options.cwd as string,
      env: options.env,
    });
    const res = await proc.wait();
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.stdoutTail);
  }

  it("sets PWD in the child to the resolved cwd when cwd differs from the parent's", async () => {
    const dir = realpathSync(makeTmpDir());
    try {
      expect(dir).not.toBe(realpathSync(process.cwd()));
      const child = await runEnvProbe({ cwd: dir });
      expect(child.PWD).toBe(dir);
      expect(realpathSync(child.cwd)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets PWD to the resolved cwd when options.env is also given", async () => {
    const dir = realpathSync(makeTmpDir());
    try {
      const child = await runEnvProbe({ cwd: dir, env: { FOO: "bar" } });
      expect(child.PWD).toBe(dir);
      expect(child.FOO).toBe("bar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overrides a PWD passed in options.env with the cwd", async () => {
    const dir = realpathSync(makeTmpDir());
    try {
      const child = await runEnvProbe({ cwd: dir, env: { PWD: "/not/the/cwd" } });
      expect(child.PWD).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the environment unchanged when no cwd is given", async () => {
    const child = await runEnvProbe({ env: { FOO: "bar" } });
    expect(child.FOO).toBe("bar");
    expect(child.PWD).toBeNull();
  });

  it("without cwd or options.env the child inherits the parent's PWD untouched", async () => {
    const parentPwd = process.env.PWD ?? null;
    const proc = spawnSupervisedProcess({
      command: process.execPath,
      args: ["-e", printEnv],
      cwd: undefined as unknown as string,
    });
    const res = await proc.wait();
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdoutTail).PWD).toBe(parentPwd);
  });
});
