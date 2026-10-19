import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  archiveRun,
  archiveSummary,
  currentVersion,
  readIndex,
  type ArchiveRecord,
} from "../../../src/archive/index.js";
import { archiveCommand } from "../../../src/cli/commands/archive.js";
import { gcCommand } from "../../../src/cli/commands/gc.js";
import { historyCommand } from "../../../src/cli/commands/history.js";
import type { CommandContext } from "../../../src/cli/commands/history.js";
import { Writable } from "node:stream";

describe("Archive Unit Tests (R4.4)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-archive-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockContext(args: string[] = [], flags: Record<string, any> = {}): {
    ctx: CommandContext;
    stdout: () => string;
    stderr: () => string;
  } {
    let out = "";
    let err = "";
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    }) as any;
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        err += chunk.toString();
        cb();
      },
    }) as any;

    const ctx: CommandContext = {
      cwd: tempDir,
      flags: flags as any,
      rawArgs: args,
      stdout,
      stderr,
    };

    return {
      ctx,
      stdout: () => out,
      stderr: () => err,
    };
  }

  describe("currentVersion", () => {
    it("returns v1 when .substrate/charter.md is absent", () => {
      expect(currentVersion(tempDir)).toBe("v1");
      expect(currentVersion(path.join(tempDir, ".substrate"))).toBe("v1");
    });

    it("parses version frontmatter from charter.md", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(
        path.join(substrateDir, "charter.md"),
        "---\nversion: v2.5\n---\n# Charter\n",
        "utf8"
      );
      expect(currentVersion(tempDir)).toBe("v2.5");
      expect(currentVersion(substrateDir)).toBe("v2.5");
    });
  });

  describe("summary sections", () => {
    it("renders sections in exact order with expected data", async () => {
      const runId = "r_TESTSUMM01";
      const runDir = path.join(tempDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });

      // Decisions with 25 lines - only first 20 should be included
      const decisionLines = Array.from({ length: 25 }, (_, i) => `Decision ${i + 1}: Reason ${i + 1}`);
      fs.writeFileSync(path.join(runDir, "decisions.md"), decisionLines.join("\n") + "\n", "utf8");

      // Events with tasks and usage
      const events = [
        {
          v: 1,
          seq: 1,
          ts: "2026-10-19T10:00:00Z",
          run_id: runId,
          type: "run.created",
          data: { run_id: runId, goal: "Build summary test" },
        },
        {
          v: 1,
          seq: 2,
          ts: "2026-10-19T10:00:01Z",
          run_id: runId,
          type: "setup.done",
          data: { tasks: [{ id: "T1", depends_on: [] }] },
        },
        {
          v: 1,
          seq: 3,
          ts: "2026-10-19T10:00:02Z",
          run_id: runId,
          type: "task.ready",
          data: { task_id: "T1" },
        },
        {
          v: 1,
          seq: 4,
          ts: "2026-10-19T10:00:03Z",
          run_id: runId,
          type: "task.passed",
          data: { task_id: "T1" },
        },
        {
          v: 1,
          seq: 5,
          ts: "2026-10-19T10:00:04Z",
          run_id: runId,
          type: "task.merged",
          data: { task_id: "T1" },
        },
        {
          v: 1,
          seq: 6,
          ts: "2026-10-19T10:00:05Z",
          run_id: runId,
          type: "usage.recorded",
          data: {
            task_id: "T1",
            role: "worker",
            record: {
              input_tokens: 1500,
              output_tokens: 300,
              cost_usd: 0.045,
              cost_source: "known",
            },
          },
        },
        {
          v: 1,
          seq: 7,
          ts: "2026-10-19T10:00:06Z",
          run_id: runId,
          type: "usage.recorded",
          data: {
            task_id: "T1",
            role: "worker",
            record: {
              input_tokens: 500,
              output_tokens: 100,
              cost_usd: 0.015,
              cost_source: "unknown",
            },
          },
        },
        {
          v: 1,
          seq: 8,
          ts: "2026-10-19T10:00:07Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0, status: "finished" },
        },
      ];

      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8"
      );

      const record = await archiveRun({
        repoRoot: tempDir,
        runId: runId as any,
        runDir,
      });

      const summary = fs.readFileSync(path.join(record.dir, "summary.md"), "utf8");

      const goalIdx = summary.indexOf("## Goal");
      const outcomeIdx = summary.indexOf("## Outcome");
      const tasksIdx = summary.indexOf("## Tasks");
      const usageIdx = summary.indexOf("## Usage");
      const learnedIdx = summary.indexOf("## What was learned");

      expect(goalIdx).toBeGreaterThan(-1);
      expect(outcomeIdx).toBeGreaterThan(goalIdx);
      expect(tasksIdx).toBeGreaterThan(outcomeIdx);
      expect(usageIdx).toBeGreaterThan(tasksIdx);
      expect(learnedIdx).toBeGreaterThan(usageIdx);

      expect(summary).toContain("Build summary test");
      expect(summary).toContain("Status: finished");
      expect(summary).toContain("Exit code: 0");
      expect(summary).toContain("| T1 | MERGED | 1 | - |");
      expect(summary).toContain("Input tokens: 2000");
      expect(summary).toContain("Output tokens: 400");
      expect(summary).toContain("Cost: $0.0600");
      expect(summary).toContain("Unknown rows: 1");

      // Verify what was learned has exactly first 20 lines
      expect(summary).toContain("Decision 1: Reason 1");
      expect(summary).toContain("Decision 20: Reason 20");
      expect(summary).not.toContain("Decision 21: Reason 21");
    });

    it("handles absent decisions and absent tasks with (none)", async () => {
      const runId = "r_TESTEMPTY01";
      const runDir = path.join(tempDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });

      const events = [
        {
          v: 1,
          seq: 1,
          ts: "2026-10-19T10:00:00Z",
          run_id: runId,
          type: "run.created",
          data: { run_id: runId, prompt: "Empty run test" },
        },
        {
          v: 1,
          seq: 2,
          ts: "2026-10-19T10:00:01Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 1, status: "failed" },
        },
      ];

      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8"
      );

      const record = await archiveRun({
        repoRoot: tempDir,
        runId: runId as any,
        runDir,
      });

      const summary = fs.readFileSync(path.join(record.dir, "summary.md"), "utf8");
      expect(summary).toContain("## Tasks\n\n(none)");
      expect(summary).toContain("## What was learned\n\n(none)");
      expect(summary).toContain("Status: failed");
      expect(summary).toContain("Exit code: 1");
    });
  });

  describe("INDEX de-duplication", () => {
    it("updates existing entry rather than adding twice", async () => {
      const runId = "r_DEDUP000001";
      const runDir = path.join(tempDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });

      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T10:00:00Z",
          run_id: runId,
          type: "run.created",
          data: { run_id: runId, goal: "Initial goal" },
        }) + "\n",
        "utf8"
      );

      await archiveRun({
        repoRoot: tempDir,
        runId: runId as any,
        runDir,
      });

      const indexPath = path.join(tempDir, ".substrate", "archive", "v1", "INDEX.md");
      let indexContent = fs.readFileSync(indexPath, "utf8");
      let lines = indexContent.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(runId);
      expect(lines[0]).toContain("Initial goal");

      // Re-archive with updated goal and finished status
      fs.appendFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 2,
          ts: "2026-10-19T10:05:00Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0, status: "finished" },
        }) + "\n",
        "utf8"
      );

      await archiveRun({
        repoRoot: tempDir,
        runId: runId as any,
        runDir,
      });

      indexContent = fs.readFileSync(indexPath, "utf8");
      lines = indexContent.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(runId);
      expect(lines[0]).toContain("finished");

      const records = readIndex(path.join(tempDir, ".substrate"), "v1");
      expect(records.length).toBe(1);
      expect(records[0].run_id).toBe(runId);
      expect(records[0].status).toBe("finished");
    });
  });

  describe("gc age rule", () => {
    it("only removes runs that are archived AND older than cutoff", async () => {
      const runsDir = path.join(tempDir, ".substrate", "runs");
      const archiveDir = path.join(tempDir, ".substrate", "archive", "v1");
      fs.mkdirSync(runsDir, { recursive: true });

      const oldRunId = "r_OLD00000001";
      const newRunId = "r_NEW00000002";
      const unarchivedRunId = "r_UNARCHIVED";

      // Create run directories
      fs.mkdirSync(path.join(runsDir, oldRunId), { recursive: true });
      fs.mkdirSync(path.join(runsDir, newRunId), { recursive: true });
      fs.mkdirSync(path.join(runsDir, unarchivedRunId), { recursive: true });

      // Create archive for oldRun (mtime 40 days ago)
      const oldArchive = path.join(archiveDir, oldRunId);
      fs.mkdirSync(oldArchive, { recursive: true });
      const oldSummary = path.join(oldArchive, "summary.md");
      fs.writeFileSync(oldSummary, "## Summary\n", "utf8");
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldSummary, fortyDaysAgo, fortyDaysAgo);

      // Create archive for newRun (mtime 10 days ago)
      const newArchive = path.join(archiveDir, newRunId);
      fs.mkdirSync(newArchive, { recursive: true });
      const newSummary = path.join(newArchive, "summary.md");
      fs.writeFileSync(newSummary, "## Summary\n", "utf8");
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(newSummary, tenDaysAgo, tenDaysAgo);

      // Execute gc with default 30d
      const { ctx, stdout } = createMockContext([], { olderThan: "30d" });
      const code = await gcCommand.execute(ctx);

      expect(code).toBe(0);
      expect(stdout()).toBe("removed 1 run(s)\n");

      // oldRun should be removed from runs/
      expect(fs.existsSync(path.join(runsDir, oldRunId))).toBe(false);

      // newRun should still exist (newer than 30d)
      expect(fs.existsSync(path.join(runsDir, newRunId))).toBe(true);

      // unarchivedRun should still exist (never deleted)
      expect(fs.existsSync(path.join(runsDir, unarchivedRunId))).toBe(true);

      // Archive itself is untouched
      expect(fs.existsSync(oldArchive)).toBe(true);
      expect(fs.existsSync(newArchive)).toBe(true);
    });
  });

  describe("history JSON shape", () => {
    it("outputs {version, runs} for current version and {versions} for all versions", async () => {
      const substrateDir = path.join(tempDir, ".substrate");
      const v1Archive = path.join(substrateDir, "archive", "v1");
      const v2Archive = path.join(substrateDir, "archive", "v2");
      fs.mkdirSync(v1Archive, { recursive: true });
      fs.mkdirSync(v2Archive, { recursive: true });

      fs.writeFileSync(
        path.join(v1Archive, "INDEX.md"),
        "- r_RUN00000001 | finished | Run one goal | 2026-10-19T10:00:00Z\n",
        "utf8"
      );

      fs.writeFileSync(
        path.join(v2Archive, "INDEX.md"),
        "- r_RUN00000002 | failed | Run two goal | 2026-10-19T11:00:00Z\n",
        "utf8"
      );

      // 1. Single version (default v1)
      const mockSingle = createMockContext([], { outputFormat: "json" });
      const codeSingle = await historyCommand.execute(mockSingle.ctx);
      expect(codeSingle).toBe(0);

      const jsonSingle = JSON.parse(mockSingle.stdout());
      expect(jsonSingle).toHaveProperty("version", "v1");
      expect(jsonSingle).toHaveProperty("runs");
      expect(Array.isArray(jsonSingle.runs)).toBe(true);
      expect(jsonSingle.runs.length).toBe(1);
      expect(jsonSingle.runs[0]).toEqual({
        run_id: "r_RUN00000001",
        status: "finished",
        goal: "Run one goal",
        ended_at: "2026-10-19T10:00:00Z",
        dir: path.join(v1Archive, "r_RUN00000001"),
      });

      // 2. All versions
      const mockAll = createMockContext([], { outputFormat: "json", allVersions: true });
      const codeAll = await historyCommand.execute(mockAll.ctx);
      expect(codeAll).toBe(0);

      const jsonAll = JSON.parse(mockAll.stdout());
      expect(jsonAll).toHaveProperty("versions");
      expect(Array.isArray(jsonAll.versions)).toBe(true);
      expect(jsonAll.versions.length).toBe(2);

      const v1Entry = jsonAll.versions.find((v: any) => v.version === "v1");
      const v2Entry = jsonAll.versions.find((v: any) => v.version === "v2");
      expect(v1Entry).toBeDefined();
      expect(v2Entry).toBeDefined();
      expect(v1Entry.runs.length).toBe(1);
      expect(v2Entry.runs.length).toBe(1);
      expect(v2Entry.runs[0].run_id).toBe("r_RUN00000002");
    });

    it("prints 'no archived runs' and exits 0 when no archive exists", async () => {
      const mock = createMockContext();
      const code = await historyCommand.execute(mock.ctx);
      expect(code).toBe(0);
      expect(mock.stdout()).toBe("no archived runs\n");
    });
  });

  describe("archive command", () => {
    it("exits 2 when run id is missing or unknown", async () => {
      const mockMissing = createMockContext([]);
      const codeMissing = await archiveCommand.execute(mockMissing.ctx);
      expect(codeMissing).toBe(2);
      expect(mockMissing.stderr()).toContain("Error: run ID required");

      const mockUnknown = createMockContext(["r_UNKNOWN9999"]);
      const codeUnknown = await archiveCommand.execute(mockUnknown.ctx);
      expect(codeUnknown).toBe(2);
      expect(mockUnknown.stderr()).toContain("Error: run r_UNKNOWN9999 not found");
    });

    it("exits 1 with Error: run <id> is not terminal when run is still in progress", async () => {
      const runId = "r_RUNPROGRESS";
      const runDir = path.join(tempDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });

      // Run only has created event, no finished/terminal event
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T10:00:00Z",
          run_id: runId,
          type: "run.created",
          data: { run_id: runId },
        }) + "\n",
        "utf8"
      );

      const mock = createMockContext([runId]);
      const code = await archiveCommand.execute(mock.ctx);
      expect(code).toBe(1);
      expect(mock.stderr()).toBe(`Error: run ${runId} is not terminal\n`);
    });

    it("re-archives a terminal run successfully and updates INDEX.md", async () => {
      const runId = "r_TERMINAL01";
      const runDir = path.join(tempDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });

      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        [
          JSON.stringify({
            v: 1,
            seq: 1,
            ts: "2026-10-19T10:00:00Z",
            run_id: runId,
            type: "run.created",
            data: { run_id: runId, prompt: "Terminal archive command test" },
          }),
          JSON.stringify({
            v: 1,
            seq: 2,
            ts: "2026-10-19T10:01:00Z",
            run_id: runId,
            type: "run.finished",
            data: { exit_code: 0, status: "finished" },
          }),
        ].join("\n") + "\n",
        "utf8"
      );

      const mock = createMockContext([runId]);
      const code = await archiveCommand.execute(mock.ctx);
      expect(code).toBe(0);
      expect(mock.stdout()).toContain(`archived run ${runId}`);

      const summaryFile = path.join(tempDir, ".substrate", "archive", "v1", runId, "summary.md");
      expect(fs.existsSync(summaryFile)).toBe(true);
    });
  });

  describe("gc command validation", () => {
    it("exits 2 on invalid --older-than format", async () => {
      const mock = createMockContext([], { olderThan: "invalid_age" });
      const code = await gcCommand.execute(mock.ctx);
      expect(code).toBe(2);
      expect(mock.stderr()).toContain('Error: invalid --older-than "invalid_age"');
    });
  });
});
