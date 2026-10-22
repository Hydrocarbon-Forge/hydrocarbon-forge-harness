import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import * as Contracts from "../../../src/contracts/index.js";

async function loadResumeCommand(): Promise<{ resumeCommand: { execute(ctx: any): Promise<number> } }> {
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

describe("resume of a run that recorded verify and context", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-resume-recorded-"));
    mkdirSync(join(tmpDir, ".substrate"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resumes without a settings error and calls Engine.resume for the run", async () => {
    const { resumeCommand } = await loadResumeCommand();
    const runId = "r_RECORDEDRUN01" as Contracts.RunId;
    const runDir = join(tmpDir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const ts = "2026-10-22T10:00:00.000Z";
    const events = [
      {
        v: 1,
        seq: 1,
        ts,
        run_id: runId,
        type: "run.created",
        data: {
          run_id: runId,
          mode: "solo",
          max_budget_usd: 5,
          verify: ["npm test"],
          context: ["README.md"],
          history_all: true,
        },
      },
      { v: 1, seq: 2, ts, run_id: runId, type: "run.paused", data: { reason: "stopped" } },
    ];
    writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    let resumedRunId: Contracts.RunId | undefined;
    const engine: Contracts.Engine = {
      async run(): Promise<Contracts.RunSummary> {
        throw new Error("not used");
      },
      async resume(rid: Contracts.RunId): Promise<Contracts.RunSummary> {
        resumedRunId = rid;
        return {
          run_id: rid,
          status: "finished",
          tasks: {},
          usage: { total_usd: 0, by_role: {} },
          branch: undefined,
          exit_code: 0,
        } as Contracts.RunSummary;
      },
    } as Contracts.Engine;

    const sessionStore = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        return undefined;
      },
      async list() {
        return [
          {
            sessionId: "sess_recorded",
            createdAt: ts,
            updatedAt: ts,
            mode: "solo",
            prompts: [],
            runs: [runId],
          },
        ];
      },
      async addRun() {},
      async fork() {
        throw new Error("not used");
      },
    } as any;

    const stderr = createMockStream();
    const ctx = {
      cwd: tmpDir,
      flags: {},
      rawArgs: [runId],
      stdout: createMockStream(),
      stderr,
      engine,
      sessionStore,
    };

    const exitCode = await resumeCommand.execute(ctx);
    expect(exitCode).not.toBe(2);
    expect(stderr.getOutput()).not.toContain("Error loading settings");
    expect(resumedRunId).toBe(runId);
  });
});
