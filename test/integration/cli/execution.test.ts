import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import type { CliGlobalFlags, CliGovernanceFlags, ParsedCliFlags } from "./flags.test.js";
import type { SessionRecord, SessionStore } from "../../unit/store/sessions.test.js";

export interface CommandContext {
  cwd: string;
  flags: ParsedCliFlags;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: Contracts.Engine;
  sessionStore?: SessionStore;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

async function loadRunCommand(): Promise<{ runCommand: CliCommand }> {
  return (await import("../../../src/cli/commands/run.js" as any)) as any;
}

async function loadPlanCommand(): Promise<{ planCommand: CliCommand }> {
  return (await import("../../../src/cli/commands/plan.js" as any)) as any;
}

async function loadResumeCommand(): Promise<{ resumeCommand: CliCommand }> {
  return (await import("../../../src/cli/commands/resume.js" as any)) as any;
}

function createMockStream(): NodeJS.WriteStream & { getOutput: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as any;
  stream.isTTY = false;
  stream.getOutput = () => output;
  return stream;
}

function createMockEngine(behavior: {
  runResult?: Partial<Contracts.RunSummary>;
  resumeResult?: Partial<Contracts.RunSummary>;
  runError?: Error;
  onRun?: (opts: Contracts.RunOptions) => void;
  onResume?: (runId: Contracts.RunId, opts?: Partial<Contracts.RunOptions>) => void;
}): Contracts.Engine {
  return {
    async run(opts: Contracts.RunOptions): Promise<Contracts.RunSummary> {
      behavior.onRun?.(opts);
      if (behavior.runError) throw behavior.runError;
      const defaultSummary: Contracts.RunSummary = {
        run_id: createRunId() as Contracts.RunId,
        status: "finished",
        tasks: {
          T1: { state: "verified", generation: 1 },
        },
        usage: { total_usd: 0.15, by_role: { worker: 0.15 } },
        branch: "substrate/runs/r_TEST",
        exit_code: 0,
      };
      return { ...defaultSummary, ...(behavior.runResult ?? {}) };
    },
    async resume(runId: Contracts.RunId, opts?: Partial<Contracts.RunOptions>): Promise<Contracts.RunSummary> {
      behavior.onResume?.(runId, opts);
      const defaultSummary: Contracts.RunSummary = {
        run_id: runId,
        status: "finished",
        tasks: {},
        usage: { total_usd: 0.05, by_role: {} },
        branch: `substrate/runs/${runId}`,
        exit_code: 0,
      };
      return { ...defaultSummary, ...(behavior.resumeResult ?? {}) };
    },
  };
}

function createMockSessionStore(initialSession?: SessionRecord): SessionStore & {
  addedRuns: Array<{ sid: string; rid: Contracts.RunId; p?: string }>;
} {
  const sessions = new Map<string, SessionRecord>();
  if (initialSession) sessions.set(initialSession.sessionId, initialSession);
  const addedRuns: Array<{ sid: string; rid: Contracts.RunId; p?: string }> = [];

  return {
    addedRuns,
    async create(opts) {
      const rec: SessionRecord = {
        sessionId: `sess_${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mode: opts.mode,
        prompts: opts.prompt ? [{ prompt: opts.prompt, timestamp: new Date().toISOString() }] : [],
        runs: [],
      };
      sessions.set(rec.sessionId, rec);
      return rec;
    },
    async get(id) {
      return sessions.get(id) ?? null;
    },
    async list() {
      return Array.from(sessions.values());
    },
    async getLatest() {
      const all = Array.from(sessions.values());
      return all.length > 0 ? all[all.length - 1] : null;
    },
    async addRun(sid, rid, p) {
      const rec = sessions.get(sid);
      if (!rec) throw new Error(`Session ${sid} not found`);
      rec.runs.push(rid);
      if (p) rec.prompts.push({ prompt: p, timestamp: new Date().toISOString() });
      rec.updatedAt = new Date().toISOString();
      addedRuns.push({ sid, rid, p });
      return rec;
    },
    async fork(id) {
      const rec = sessions.get(id);
      if (!rec) throw new Error("No session to fork");
      const forked: SessionRecord = {
        sessionId: `sess_fork_${Date.now()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mode: rec.mode,
        prompts: [...rec.prompts],
        runs: [],
      };
      sessions.set(forked.sessionId, forked);
      return forked;
    },
  };
}

describe("cli: execution commands (run, plan, resume)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-exec-test-"));
    mkdirSync(join(tmpDir, ".substrate"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("run command", () => {
    it("defaults permission mode to dontAsk in headless execution when not explicitly specified", async () => {
      const { runCommand } = await loadRunCommand();

      let capturedOpts: Contracts.RunOptions | undefined;
      const engine = createMockEngine({
        onRun: (opts) => {
          capturedOpts = opts;
        },
      });
      const sessionStore = createMockSessionStore();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["build the database migration"],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore,
      };

      const exitCode = await runCommand.execute(ctx);
      expect(exitCode).toBe(0);
      expect(capturedOpts).toBeDefined();
      expect(capturedOpts?.permission_mode).toBe("dontAsk");
      expect(capturedOpts?.mode).toBe("auto");
    });

    it("respects explicitly specified permissionMode flag", async () => {
      const { runCommand } = await loadRunCommand();

      let capturedOpts: Contracts.RunOptions | undefined;
      const engine = createMockEngine({
        onRun: (opts) => {
          capturedOpts = opts;
        },
      });
      const sessionStore = createMockSessionStore();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: { permissionMode: "acceptEdits" },
        rawArgs: ["build the database migration"],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore,
      };

      const exitCode = await runCommand.execute(ctx);
      expect(exitCode).toBe(0);
      expect(capturedOpts?.permission_mode).toBe("acceptEdits");
    });

    it("applies flag overlays to settings: model, workerModel, effort, allowedTools, disallowedTools, budgets, sandbox", async () => {
      const { runCommand } = await loadRunCommand();

      let capturedOpts: Contracts.RunOptions | undefined;
      const engine = createMockEngine({
        onRun: (opts) => {
          capturedOpts = opts;
        },
      });
      const sessionStore = createMockSessionStore();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {
          model: "claude-sonnet-5-5",
          workerModel: "claude-haiku-4-5",
          effort: "high",
          allowedTools: ["Bash", "FileWrite(*)"],
          disallowedTools: ["Bash(git push*)"],
          maxBudgetUsd: 12.0,
          timeout: 40,
          sandbox: true,
          noGovernor: true,
        },
        rawArgs: ["deploy microservice"],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore,
      };

      const exitCode = await runCommand.execute(ctx);
      expect(exitCode).toBe(0);
      expect(capturedOpts).toBeDefined();

      const overrides = capturedOpts?.overrides;
      expect(overrides).toBeDefined();
      expect(overrides?.roles?.planner?.model).toBe("claude-sonnet-5-5");
      expect(overrides?.budgets?.run?.max_usd).toBe(12.0);
      expect(overrides?.budgets?.run?.max_wall_min).toBe(40);
      expect(overrides?.sandbox?.enabled).toBe(true);
      expect(overrides?.permissions?.allow).toContain("Bash");
      expect(overrides?.permissions?.deny).toContain("Bash(git push*)");
    });

    it("links executed run to active or newly created session in sessionStore", async () => {
      const { runCommand } = await loadRunCommand();

      const engine = createMockEngine({
        runResult: { run_id: "r_A1B2C3D4E5F6" as Contracts.RunId },
      });
      const sessionStore = createMockSessionStore();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["test session link"],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore,
      };

      await runCommand.execute(ctx);

      expect(sessionStore.addedRuns).toHaveLength(1);
      expect(sessionStore.addedRuns[0].rid).toBe("r_A1B2C3D4E5F6");
      expect(sessionStore.addedRuns[0].p).toBe("test session link");
    });

    describe("Exit Code Enforcement (§4.6)", () => {
      it("returns exit code 0 when run finishes with status 'finished' and all tasks passed", async () => {
        const { runCommand } = await loadRunCommand();
        const engine = createMockEngine({
          runResult: { status: "finished", exit_code: 0 },
        });

        const ctx: CommandContext = {
          cwd: tmpDir,
          flags: {},
          rawArgs: ["task success"],
          stdout: createMockStream(),
          stderr: createMockStream(),
          engine,
          sessionStore: createMockSessionStore(),
        };

        expect(await runCommand.execute(ctx)).toBe(0);
      });

      it("returns exit code 1 when run status is 'failed' or any task failed permanently", async () => {
        const { runCommand } = await loadRunCommand();
        const engine = createMockEngine({
          runResult: {
            status: "failed",
            tasks: {
              T1: { state: "failed", generation: 2, failure_class: "verify_failed" },
            },
            exit_code: 1,
          },
        });

        const ctx: CommandContext = {
          cwd: tmpDir,
          flags: {},
          rawArgs: ["failing task"],
          stdout: createMockStream(),
          stderr: createMockStream(),
          engine,
          sessionStore: createMockSessionStore(),
        };

        expect(await runCommand.execute(ctx)).toBe(1);
      });

      it("returns exit code 2 on missing prompt or usage error", async () => {
        const { runCommand } = await loadRunCommand();

        const ctx: CommandContext = {
          cwd: tmpDir,
          flags: {},
          rawArgs: [], // Missing prompt
          stdout: createMockStream(),
          stderr: createMockStream(),
          engine: createMockEngine({}),
          sessionStore: createMockSessionStore(),
        };

        expect(await runCommand.execute(ctx)).toBe(2);
      });

      it("returns exit code 3 when run pauses due to needs_approval or permission_denied or needs_human", async () => {
        const { runCommand } = await loadRunCommand();
        const reasons: Contracts.PauseReason[] = ["needs_approval", "permission_denied", "needs_human"];

        for (const pause_reason of reasons) {
          const engine = createMockEngine({
            runResult: { status: "paused", pause_reason, exit_code: 3 },
          });

          const ctx: CommandContext = {
            cwd: tmpDir,
            flags: {},
            rawArgs: ["paused task"],
            stdout: createMockStream(),
            stderr: createMockStream(),
            engine,
            sessionStore: createMockSessionStore(),
          };

          expect(await runCommand.execute(ctx)).toBe(3);
        }
      });

      it("returns exit code 4 when run pauses or fails due to budget_exhausted", async () => {
        const { runCommand } = await loadRunCommand();
        const engine = createMockEngine({
          runResult: { status: "paused", pause_reason: "budget_exhausted", exit_code: 4 },
        });

        const ctx: CommandContext = {
          cwd: tmpDir,
          flags: {},
          rawArgs: ["expensive task"],
          stdout: createMockStream(),
          stderr: createMockStream(),
          engine,
          sessionStore: createMockSessionStore(),
        };

        expect(await runCommand.execute(ctx)).toBe(4);
      });

      it("returns exit code 130 on SIGINT user interrupt", async () => {
        const { runCommand } = await loadRunCommand();
        const abortErr = new Error("SIGINT");
        abortErr.name = "AbortError";

        const engine = createMockEngine({
          runError: abortErr,
        });

        const ctx: CommandContext = {
          cwd: tmpDir,
          flags: {},
          rawArgs: ["cancelled task"],
          stdout: createMockStream(),
          stderr: createMockStream(),
          engine,
          sessionStore: createMockSessionStore(),
        };

        expect(await runCommand.execute(ctx)).toBe(130);
      });
    });
  });

  describe("plan command", () => {
    it("forces permission_mode to 'plan' and requires a prompt", async () => {
      const { planCommand } = await loadPlanCommand();

      let capturedOpts: Contracts.RunOptions | undefined;
      const engine = createMockEngine({
        onRun: (opts) => {
          capturedOpts = opts;
        },
      });

      // 1. Missing prompt -> exit 2
      const ctxMissing: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore: createMockSessionStore(),
      };
      expect(await planCommand.execute(ctxMissing)).toBe(2);

      // 2. Valid prompt -> forces permission_mode: "plan"
      const ctxValid: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["plan architecture rewrite"],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore: createMockSessionStore(),
      };
      const exitCode = await planCommand.execute(ctxValid);
      expect(exitCode).toBe(0);
      expect(capturedOpts?.permission_mode).toBe("plan");
    });
  });

  describe("resume command", () => {
    it("resolves target run ID, invokes Engine.resume, and returns exit code", async () => {
      const { resumeCommand } = await loadResumeCommand();

      const runId = createRunId() as Contracts.RunId;
      let resumedRunId: Contracts.RunId | undefined;

      const engine = createMockEngine({
        onResume: (rid) => {
          resumedRunId = rid;
        },
      });

      const sessionStore = createMockSessionStore({
        sessionId: "sess_resume_test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mode: "auto",
        prompts: [{ prompt: "Initial", timestamp: new Date().toISOString() }],
        runs: [runId],
      });

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["sess_resume_test"],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore,
      };

      const exitCode = await resumeCommand.execute(ctx);
      expect(exitCode).toBe(0);
      expect(resumedRunId).toBe(runId);
    });

    it("exits 0 without creating redundant effects loop when resuming already finished run", async () => {
      const { resumeCommand } = await loadResumeCommand();

      const runId = createRunId() as Contracts.RunId;
      let resumeCalled = false;

      // Create run directory with finished state marker
      const runDir = join(tmpDir, ".substrate", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: new Date().toISOString(),
          run_id: runId,
          type: "run.finished",
          data: { status: "finished" },
        }) + "\n",
      );

      const engine = createMockEngine({
        onResume: () => {
          resumeCalled = true;
        },
      });

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine,
        sessionStore: createMockSessionStore(),
      };

      const exitCode = await resumeCommand.execute(ctx);
      expect(exitCode).toBe(0);
      expect(resumeCalled).toBe(false); // Resuming already finished run does not re-invoke engine
    });

    it("returns exit code 2 when resume target is not found", async () => {
      const { resumeCommand } = await loadResumeCommand();

      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["nonexistent-run-id"],
        stdout: createMockStream(),
        stderr: createMockStream(),
        engine: createMockEngine({}),
        sessionStore: createMockSessionStore(),
      };

      const exitCode = await resumeCommand.execute(ctx);
      expect(exitCode).toBe(2);
    });
  });
});
