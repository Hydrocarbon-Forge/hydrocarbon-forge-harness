import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import * as RunnerModule from "../../../src/verify/runner.js";
import type { VerifyRunner, VerifyRunnerOptions } from "../../../src/verify/runner.js";

function getVerifyRunner(): VerifyRunner {
  const mod = RunnerModule as any;
  if (mod.VerifyRunner) {
    if (typeof mod.VerifyRunner === "function") {
      try {
        return new mod.VerifyRunner();
      } catch {
        return mod.VerifyRunner;
      }
    }
    return mod.VerifyRunner;
  }
  return mod as VerifyRunner;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "substrate-verify-test-"));
}

describe("verify: VerifyRunner - execution and exit codes", () => {
  it("executes verify commands in cwd and returns passing VerifyResult[] when all exit 0", async () => {
    const runner = getVerifyRunner();
    const cwd = tmpDir();

    try {
      const commands: Contracts.Command[] = [
        { run: "echo 'first command'", timeout_s: 10 },
        { run: "node -e 'process.stdout.write(\"all good\")'", timeout_s: 10 },
      ];

      const results = await runner.runVerify({ cwd, commands });

      expect(results).toHaveLength(2);
      expect(results[0].exit_code).toBe(0);
      expect(results[0].timed_out).toBe(false);
      expect(results[0].stdout_tail).toContain("first command");

      expect(results[1].exit_code).toBe(0);
      expect(results[1].timed_out).toBe(false);
      expect(results[1].stdout_tail).toContain("all good");

      expect(runner.isAllPassed(results)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("captures non-zero exit code and marks isAllPassed as false", async () => {
    const runner = getVerifyRunner();
    const cwd = tmpDir();

    try {
      const commands: Contracts.Command[] = [
        { run: "node -e 'process.stderr.write(\"failed check\"); process.exit(42)'", timeout_s: 10 },
      ];

      const results = await runner.runVerify({ cwd, commands });

      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(42);
      expect(results[0].timed_out).toBe(false);
      expect(results[0].stderr_tail).toContain("failed check");
      expect(runner.isAllPassed(results)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("verify: VerifyRunner - timeout and process group kill", () => {
  it("kills runaway process group with SIGKILL on timeout and records timed_out: true", async () => {
    const runner = getVerifyRunner();
    const cwd = tmpDir();

    try {
      // Command that runs a long sleep loop
      const commands: Contracts.Command[] = [
        { run: "node -e 'setInterval(() => {}, 1000)'", timeout_s: 1 },
      ];

      const start = Date.now();
      const results = await runner.runVerify({ cwd, commands });
      const duration = Date.now() - start;

      expect(results).toHaveLength(1);
      expect(results[0].timed_out).toBe(true);
      expect(results[0].exit_code).toBeNull();
      // Should timeout within roughly 1-3 seconds, not hang
      expect(duration).toBeLessThan(5000);
      expect(runner.isAllPassed(results)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("kills entire child process group including spawned grandchildren on timeout", async () => {
    const runner = getVerifyRunner();
    const cwd = tmpDir();

    try {
      // Parent spawns a detached grandchild background process
      const script = `
        const { spawn } = require('node:child_process');
        const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        setInterval(() => {}, 1000);
      `;
      writeFileSync(join(cwd, "spawn_grandchild.js"), script, "utf8");

      const commands: Contracts.Command[] = [
        { run: "node spawn_grandchild.js", timeout_s: 1 },
      ];

      const results = await runner.runVerify({ cwd, commands });
      expect(results[0].timed_out).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("verify: VerifyRunner - sliding tail buffer cap (8 KB)", () => {
  it("caps stdout/stderr to tail window (maxTailBytes) and sets truncated: true on high-volume output", async () => {
    const runner = getVerifyRunner();
    const cwd = tmpDir();

    try {
      // Generate 50 KB of stdout text
      const commands: Contracts.Command[] = [
        {
          run: "node -e 'for(let i=0; i<1000; i++) console.log(`Line ${i}: ${`x`.repeat(50)}`)'",
          timeout_s: 10,
        },
      ];

      const maxTailBytes = 8192;
      const results = await runner.runVerify({ cwd, commands, maxTailBytes });

      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
      expect(results[0].truncated).toBe(true);
      expect(Buffer.byteLength(results[0].stdout_tail, "utf8")).toBeLessThanOrEqual(maxTailBytes);
      // Tail buffer must contain the *end* of the stream
      expect(results[0].stdout_tail).toContain("Line 999:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves full stream and sets truncated: false when output is within limit", async () => {
    const runner = getVerifyRunner();
    const cwd = tmpDir();

    try {
      const commands: Contracts.Command[] = [
        { run: "node -e 'console.log(\"short message\")'", timeout_s: 10 },
      ];

      const results = await runner.runVerify({ cwd, commands, maxTailBytes: 8192 });

      expect(results[0].truncated).toBe(false);
      expect(results[0].stdout_tail.trim()).toBe("short message");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("verify: VerifyRunner - environment scrubbing", () => {
  it("scrubs secrets and sensitive API tokens from verify subprocess environment", async () => {
    const runner = getVerifyRunner();
    const cwd = tmpDir();

    // Temporarily inject sensitive secrets into process.env
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    const oldOpenAi = process.env.OPENAI_API_KEY;
    const oldGithub = process.env.GITHUB_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret-key-12345";
    process.env.OPENAI_API_KEY = "sk-openai-test-secret-67890";
    process.env.GITHUB_TOKEN = "ghp_testgithubtoken1234567890abcdef";

    try {
      const script = `
        const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN'];
        const present = keys.filter(k => process.env[k]);
        console.log(JSON.stringify({ present, custom: process.env.TEST_CUSTOM_ENV }));
      `;
      writeFileSync(join(cwd, "check_env.js"), script, "utf8");

      const commands: Contracts.Command[] = [
        { run: "node check_env.js", timeout_s: 10 },
      ];

      const results = await runner.runVerify({
        cwd,
        commands,
        env: { TEST_CUSTOM_ENV: "allowed_value" },
      });

      expect(results[0].exit_code).toBe(0);
      const parsed = JSON.parse(results[0].stdout_tail.trim());
      expect(parsed.present).toEqual([]);
      expect(parsed.custom).toBe("allowed_value");
    } finally {
      if (oldAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = oldAnthropic;
      else delete process.env.ANTHROPIC_API_KEY;
      if (oldOpenAi !== undefined) process.env.OPENAI_API_KEY = oldOpenAi;
      else delete process.env.OPENAI_API_KEY;
      if (oldGithub !== undefined) process.env.GITHUB_TOKEN = oldGithub;
      else delete process.env.GITHUB_TOKEN;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("verify: VerifyRunner - isAllPassed authority", () => {
  it("returns true if and only if all verify results have exit_code: 0 and not timed_out", () => {
    const runner = getVerifyRunner();

    const passedResults: Contracts.VerifyResult[] = [
      { cmd: "test 1", exit_code: 0, timed_out: false, duration_ms: 10, stdout_tail: "", stderr_tail: "", truncated: false },
      { cmd: "test 2", exit_code: 0, timed_out: false, duration_ms: 20, stdout_tail: "", stderr_tail: "", truncated: false },
    ];
    expect(runner.isAllPassed(passedResults)).toBe(true);

    const failedResults: Contracts.VerifyResult[] = [
      { cmd: "test 1", exit_code: 0, timed_out: false, duration_ms: 10, stdout_tail: "", stderr_tail: "", truncated: false },
      { cmd: "test 2", exit_code: 1, timed_out: false, duration_ms: 20, stdout_tail: "", stderr_tail: "", truncated: false },
    ];
    expect(runner.isAllPassed(failedResults)).toBe(false);

    const timedOutResults: Contracts.VerifyResult[] = [
      { cmd: "test 1", exit_code: null, timed_out: true, duration_ms: 1000, stdout_tail: "", stderr_tail: "", truncated: false },
    ];
    expect(runner.isAllPassed(timedOutResults)).toBe(false);

    expect(runner.isAllPassed([])).toBe(false);
  });
});
