import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import { parseJsonc } from "../../../src/config/index.js";

export type HookEventName =
  | "PreRun"
  | "PostPlan"
  | "PreTask"
  | "PostTask"
  | "PreMerge"
  | "PostMerge"
  | "RunFinished"
  | "Notification";

export interface HookConfig {
  command: string;
  timeout_s?: number;
}

export interface HookPayloadBase {
  event: HookEventName;
  run_id: Contracts.RunId;
  cwd: string;
  timestamp: string;
}

export type HookPayload =
  | (HookPayloadBase & { event: "PreRun"; goal: string; mode: string })
  | (HookPayloadBase & { event: "PostPlan"; manifest: Contracts.Manifest })
  | (HookPayloadBase & { event: "PreTask"; task_id: Contracts.TaskId })
  | (HookPayloadBase & { event: "PostTask"; task_id: Contracts.TaskId; report: Contracts.WorkerReport });

export type HookMergePayload =
  | (HookPayloadBase & { event: "PreMerge"; task_id?: Contracts.TaskId; batch?: Contracts.TaskId[] })
  | (HookPayloadBase & { event: "PostMerge"; task_id?: Contracts.TaskId; batch?: Contracts.TaskId[]; commit_sha?: string })
  | (HookPayloadBase & { event: "RunFinished"; summary: Contracts.RunSummary })
  | (HookPayloadBase & { event: "Notification"; message: string; title?: string });

export interface HookResult {
  command: string;
  exit_code: number | null;
  blocked: boolean;
  stderr: string;
  stdout: string;
  timed_out: boolean;
  duration_ms: number;
}

export interface HookRunner {
  runHook(
    event: HookEventName,
    payload: HookPayload | HookMergePayload,
    hooksConfig?: HookConfig[]
  ): Promise<HookResult[]>;
}

async function loadHooksRunnerModule(): Promise<{
  executeHookCommand: (
    cmd: HookConfig,
    stdinJson: string,
    cwd: string
  ) => Promise<HookResult>;
  HookRunner?: new (settings?: Contracts.Settings) => HookRunner;
  HookRunnerImpl?: new (settings?: Contracts.Settings) => HookRunner;
  createHookRunner?: (settings?: Contracts.Settings) => HookRunner;
}> {
  return (await import("../../../src/hooks/runner.js" as any)) as any;
}

function createRunner(mod: any, settings?: Contracts.Settings): HookRunner {
  if (typeof mod.createHookRunner === "function") {
    return mod.createHookRunner(settings);
  }
  if (typeof mod.HookRunner === "function") {
    return new mod.HookRunner(settings);
  }
  if (typeof mod.HookRunnerImpl === "function") {
    return new mod.HookRunnerImpl(settings);
  }
  if (typeof mod.default === "function") {
    return new mod.default(settings);
  }
  throw new Error("Cannot instantiate HookRunner from module");
}

function makeSampleManifest(runId: Contracts.RunId): Contracts.Manifest {
  return {
    version: 1,
    run_id: runId,
    goal: "Sample goal for testing hooks",
    base_ref: "main",
    setup: [{ run: "echo setup", timeout_s: 30 }],
    contracts: { files: ["src/index.ts"], typecheck: [{ run: "echo typecheck", timeout_s: 30 }] },
    integration_verify: [{ run: "echo verify", timeout_s: 30 }],
    tasks: [{ id: "T1", spec: "TASK.md" }],
  };
}

function makeSampleWorkerReport(runId: Contracts.RunId): Contracts.WorkerReport {
  return {
    task_id: "T1",
    generation: 1,
    attempt: 1,
    session_id: "s_test",
    backend: "fake",
    model: "test-model",
    status: "passed",
    files_changed: ["src/feature.ts"],
    usage: {
      backend: "fake",
      model: "test-model",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.005,
      cost_source: "reported",
      at: nowIsoTimestamp(),
    },
    duration_ms: 120,
    verify: [
      {
        cmd: "npm test",
        exit_code: 0,
        timed_out: false,
        duration_ms: 50,
        stdout_tail: "ok",
        stderr_tail: "",
        truncated: false,
      },
    ],
    denials: [],
    final_message: "Completed successfully",
  };
}

function makeSampleRunSummary(runId: Contracts.RunId): Contracts.RunSummary {
  return {
    run_id: runId,
    status: "finished",
    tasks: {
      T1: {
        state: "verified",
        generation: 1,
      },
    },
    usage: {
      total_usd: 0.01,
      by_role: { worker: 0.01 },
    },
    branch: "substrate/test",
    exit_code: 0,
  };
}

describe("hooks runner & process supervision", () => {
  let tmpDir: string;
  let runId: Contracts.RunId;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-hooks-test-"));
    runId = createRunId() as Contracts.RunId;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("executeHookCommand: low-level execution semantics", () => {
    it("pipes serialized JSON payload to child stdin and closes stdin", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      const payload: HookPayload = {
        event: "PreRun",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        goal: "Test stdin piping",
        mode: "auto",
      };
      const stdinJson = JSON.stringify(payload);

      const command = `node -e 'let data = ""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const p = JSON.parse(data); process.stdout.write("EVENT:" + p.event + "|GOAL:" + p.goal); });'`;
      const result = await executeHookCommand({ command }, stdinJson, tmpDir);

      expect(result.exit_code).toBe(0);
      expect(result.blocked).toBe(false);
      expect(result.timed_out).toBe(false);
      expect(result.stdout).toBe("EVENT:PreRun|GOAL:Test stdin piping");
    });

    it("evaluates exit code 0 as continue (blocked: false)", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      const command = `node -e 'process.stdout.write("ok continue"); process.exit(0);'`;
      const result = await executeHookCommand({ command }, "{}", tmpDir);

      expect(result.exit_code).toBe(0);
      expect(result.blocked).toBe(false);
      expect(result.stdout).toBe("ok continue");
      expect(result.stderr).toBe("");
    });

    it("evaluates exit code 2 as an explicit block and captures stderr feedback", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      const command = `node -e 'process.stderr.write("Blocked by security policy: unsafe dependency"); process.exit(2);'`;
      const result = await executeHookCommand({ command }, "{}", tmpDir);

      expect(result.exit_code).toBe(2);
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain("Blocked by security policy: unsafe dependency");
    });

    it("generates synthetic feedback when hook exits 2 with empty stderr", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      const command = `node -e 'process.exit(2);'`;
      const result = await executeHookCommand({ command }, "{}", tmpDir);

      expect(result.exit_code).toBe(2);
      expect(result.blocked).toBe(true);
      expect(result.stderr).toBe("Hook command exited with code 2 but emitted no stderr");
    });

    it("evaluates other non-zero exit codes as error without blocking gate (blocked: false)", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      const command = `node -e 'process.stderr.write("Runtime error: cannot connect"); process.exit(1);'`;
      const result = await executeHookCommand({ command }, "{}", tmpDir);

      expect(result.exit_code).toBe(1);
      expect(result.blocked).toBe(false);
      expect(result.stderr).toContain("Runtime error: cannot connect");
    });

    it("handles non-existent command binary with exit_code: 127 without crashing", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      const result = await executeHookCommand(
        { command: "non_existent_binary_xyz_12345 --flag" },
        "{}",
        tmpDir
      );

      expect(result.exit_code).toBe(127);
      expect(result.blocked).toBe(false);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("enforces timeout_s and terminates child process with SIGTERM then SIGKILL", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      // Hook script that ignores SIGTERM and requires SIGKILL
      const command = `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);'`;
      const start = Date.now();
      const result = await executeHookCommand({ command, timeout_s: 1 }, "{}", tmpDir);
      const duration = Date.now() - start;

      expect(result.timed_out).toBe(true);
      expect(result.exit_code).toBeNull();
      expect(result.blocked).toBe(false);
      expect(duration).toBeGreaterThanOrEqual(900); // 1s timeout + grace
    });

    it("buffers stdout and stderr with strict 64KB tail caps", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      // Emit 100KB of data to stdout and stderr
      const command = `node -e 'const chunk = "X".repeat(1024); for (let i = 0; i < 100; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }'`;
      const result = await executeHookCommand({ command }, "{}", tmpDir);

      const maxBytes = 64 * 1024;
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxBytes);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxBytes);
    });

    it("scrubs sensitive environment variables before spawning hook child", async () => {
      const { executeHookCommand } = await loadHooksRunnerModule();

      const originalEnv = process.env.ANTHROPIC_API_KEY;
      try {
        process.env.ANTHROPIC_API_KEY = "sk-ant-api03-sensitive-secret-token";
        process.env.OPENAI_API_KEY = "sk-openai-secret-token";

        const command = `node -e 'process.stdout.write("ANTHROPIC:" + (process.env.ANTHROPIC_API_KEY || "NONE") + "|OPENAI:" + (process.env.OPENAI_API_KEY || "NONE"));'`;
        const result = await executeHookCommand({ command }, "{}", tmpDir);

        expect(result.stdout).not.toContain("sk-ant-api03-sensitive-secret-token");
        expect(result.stdout).not.toContain("sk-openai-secret-token");
      } finally {
        if (originalEnv !== undefined) {
          process.env.ANTHROPIC_API_KEY = originalEnv;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
        delete process.env.OPENAI_API_KEY;
      }
    });
  });

  describe("HookRunner: all 8 lifecycle events", () => {
    it("delivers PreRun payload to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const payload: HookPayload = {
        event: "PreRun",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        goal: "Build feature X",
        mode: "auto",
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="PreRun" && p.goal==="Build feature X") process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("PreRun", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
      expect(results[0].blocked).toBe(false);
    });

    it("delivers PostPlan payload with full manifest to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const manifest = makeSampleManifest(runId);
      const payload: HookPayload = {
        event: "PostPlan",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        manifest,
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="PostPlan" && p.manifest.tasks.length===1) process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("PostPlan", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
    });

    it("delivers PreTask payload with task_id to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const payload: HookPayload = {
        event: "PreTask",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        task_id: "T1",
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="PreTask" && p.task_id==="T1") process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("PreTask", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
    });

    it("delivers PostTask payload with worker report to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const report = makeSampleWorkerReport(runId);
      const payload: HookPayload = {
        event: "PostTask",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        task_id: "T1",
        report,
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="PostTask" && p.report.status==="passed") process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("PostTask", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
    });

    it("delivers PreMerge payload with batch/task_id to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const payload: HookMergePayload = {
        event: "PreMerge",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        task_id: "T1",
        batch: ["T1"],
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="PreMerge" && Array.isArray(p.batch)) process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("PreMerge", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
    });

    it("delivers PostMerge payload with commit_sha to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const payload: HookMergePayload = {
        event: "PostMerge",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        task_id: "T1",
        commit_sha: "abcdef1234567890",
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="PostMerge" && p.commit_sha==="abcdef1234567890") process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("PostMerge", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
    });

    it("delivers RunFinished payload with summary to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const summary = makeSampleRunSummary(runId);
      const payload: HookMergePayload = {
        event: "RunFinished",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        summary,
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="RunFinished" && p.summary.status==="finished") process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("RunFinished", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
    });

    it("delivers Notification payload with message to configured hooks", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const payload: HookMergePayload = {
        event: "Notification",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        message: "Run paused awaiting human approval",
        title: "Approval required",
      };

      const hooksConfig: HookConfig[] = [
        {
          command: `node -e 'let d=""; process.stdin.on("data", c=>d+=c); process.stdin.on("end", ()=>{ const p=JSON.parse(d); if(p.event==="Notification" && p.message.includes("paused")) process.exit(0); else process.exit(1); });'`,
        },
      ];

      const results = await runner.runHook("Notification", payload, hooksConfig);
      expect(results).toHaveLength(1);
      expect(results[0].exit_code).toBe(0);
    });

    it("returns empty array immediately if no hooks configured for event", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const payload: HookPayload = {
        event: "PreRun",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        goal: "No hooks test",
        mode: "auto",
      };

      const results = await runner.runHook("PreRun", payload, []);
      expect(results).toEqual([]);
    });
  });

  describe("sequential execution & early halting on blocking gates", () => {
    it("executes hooks sequentially in configured order", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const orderFile = join(tmpDir, "order.txt");
      writeFileSync(orderFile, "");

      const hooksConfig: HookConfig[] = [
        { command: `node -e 'require("node:fs").appendFileSync("${orderFile}", "1\\n");'` },
        { command: `node -e 'require("node:fs").appendFileSync("${orderFile}", "2\\n");'` },
        { command: `node -e 'require("node:fs").appendFileSync("${orderFile}", "3\\n");'` },
      ];

      const payload: HookPayload = {
        event: "PreRun",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        goal: "Order test",
        mode: "auto",
      };

      const results = await runner.runHook("PreRun", payload, hooksConfig);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.exit_code === 0)).toBe(true);

      const log = (await import("node:fs")).readFileSync(orderFile, "utf8");
      expect(log.trim()).toBe("1\n2\n3");
    });

    it("halts remaining hooks immediately when a blocking hook exits with code 2", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const thirdRanFile = join(tmpDir, "third.txt");

      const hooksConfig: HookConfig[] = [
        { command: `node -e 'process.exit(0);'` },
        { command: `node -e 'process.stderr.write("Blocked by hook 2"); process.exit(2);'` },
        { command: `node -e 'require("node:fs").writeFileSync("${thirdRanFile}", "ran");'` },
      ];

      const payload: HookPayload = {
        event: "PostPlan",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        manifest: makeSampleManifest(runId),
      };

      const results = await runner.runHook("PostPlan", payload, hooksConfig);

      // Must have stopped after hook 2
      expect(results).toHaveLength(2);
      expect(results[0].blocked).toBe(false);
      expect(results[1].blocked).toBe(true);
      expect(results[1].stderr).toContain("Blocked by hook 2");
      expect(existsSync(thirdRanFile)).toBe(false);
    });

    it("does not halt remaining hooks when exit code 2 occurs on non-blocking event (e.g. PostTask)", async () => {
      const runnerMod = await loadHooksRunnerModule();
      const runner = createRunner(runnerMod);

      const secondRanFile = join(tmpDir, "second.txt");

      const hooksConfig: HookConfig[] = [
        { command: `node -e 'process.stderr.write("Warning from post-task hook"); process.exit(2);'` },
        { command: `node -e 'require("node:fs").writeFileSync("${secondRanFile}", "ran"); process.exit(0);'` },
      ];

      const payload: HookPayload = {
        event: "PostTask",
        run_id: runId,
        cwd: tmpDir,
        timestamp: nowIsoTimestamp(),
        task_id: "T1",
        report: makeSampleWorkerReport(runId),
      };

      const results = await runner.runHook("PostTask", payload, hooksConfig);

      // Non-blocking event allows remaining hooks to execute
      expect(results).toHaveLength(2);
      expect(results[0].exit_code).toBe(2);
      expect(results[1].exit_code).toBe(0);
      expect(existsSync(secondRanFile)).toBe(true);
    });
  });
});
