import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";

import { mergeCommand, mergeRun, type CommandContext } from "../../../src/cli/commands/merge.js";
import { undoCommand } from "../../../src/cli/commands/undo.js";
import { discardCommand } from "../../../src/cli/commands/discard.js";

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

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Substrate Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@substrate.local"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });

  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
}

describe("CLI unit: merge, undo, discard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-mud-unit-"));
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("merge command", () => {
    it("exits 2 when run id is missing", async () => {
      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(2);
      expect(stderr.getOutput()).toContain("Error: Run ID required");
    });

    it("exits 2 when run is unknown", async () => {
      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["r_NONEXISTENT"],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(2);
      expect(stderr.getOutput()).toContain("Error: unknown run r_NONEXISTENT");
    });

    it("exits 1 when run is not finished successfully", async () => {
      const runId = "r_UNFINISHED1";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
        "utf8"
      );
      execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(1);
      expect(stderr.getOutput()).toContain(`Error: run ${runId} did not finish successfully; not merged`);
    });

    it("exits 1 when user checkout has dirty tracked files", async () => {
      const runId = "r_FINISHED01";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T00:00:00Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0 },
        }) + "\n",
        "utf8"
      );
      execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });

      // Modify tracked file
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Modified\n", "utf8");

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(1);
      expect(stderr.getOutput()).toContain("Error: uncommitted changes to tracked files; commit or stash first");
    });

    it("prints 'Already up to date.' and exits 0 when run branch is already an ancestor of HEAD", async () => {
      const runId = "r_ANCESTOR01";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T00:00:00Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0 },
        }) + "\n",
        "utf8"
      );
      // Run branch at current HEAD commit
      execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(0);
      expect(stdout.getOutput()).toContain("Already up to date.");
    });

    it("--dry-run prints would merge count and does not merge", async () => {
      const runId = "r_DRYRUN0001";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T00:00:00Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0 },
        }) + "\n",
        "utf8"
      );

      execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello\n", "utf8");
      execFileSync("git", ["add", "file1.txt"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add file1"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "main"], { cwd: tmpDir, stdio: "ignore" });

      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: { dryRun: true },
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(0);
      expect(stdout.getOutput()).toContain(`would merge 1 commit(s) from substrate/runs/${runId} into main`);

      const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();
      expect(headAfter).toBe(headBefore);
      expect(fs.existsSync(path.join(tmpDir, "file1.txt"))).toBe(false);
    });

    it("merges run branch cleanly into current branch", async () => {
      const runId = "r_MERGECLEAN";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T00:00:00Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0 },
        }) + "\n",
        "utf8"
      );

      execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "clean.txt"), "clean\n", "utf8");
      execFileSync("git", ["add", "clean.txt"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add clean"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "main"], { cwd: tmpDir, stdio: "ignore" });

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(0);
      expect(stdout.getOutput()).toContain(`Merged substrate/runs/${runId} into main`);
      expect(fs.existsSync(path.join(tmpDir, "clean.txt"))).toBe(true);
    });

    it("prints conflicting files on merge conflict without --abort-on-conflict", async () => {
      const runId = "r_CONFLICT01";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T00:00:00Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0 },
        }) + "\n",
        "utf8"
      );

      execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Conflict on branch\n", "utf8");
      execFileSync("git", ["commit", "-am", "branch edit"], { cwd: tmpDir, stdio: "ignore" });

      execFileSync("git", ["checkout", "main"], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Conflict on main\n", "utf8");
      execFileSync("git", ["commit", "-am", "main edit"], { cwd: tmpDir, stdio: "ignore" });

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await mergeCommand.execute(ctx);
      expect(code).toBe(1);
      expect(stderr.getOutput()).toContain("README.md");
    });
  });

  describe("undo command", () => {
    it("exits 2 when run is unknown", async () => {
      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["r_UNKNOWNSH0"],
        stdout,
        stderr,
      };
      const code = await undoCommand.execute(ctx);
      expect(code).toBe(2);
      expect(stderr.getOutput()).toContain("Error: unknown run r_UNKNOWNSH0");
    });

    it("exits 1 when no checkpoint is recorded", async () => {
      const runId = "r_NOCHECKPT0";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
        "utf8"
      );
      execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await undoCommand.execute(ctx);
      expect(code).toBe(1);
      expect(stderr.getOutput()).toContain(`Error: no checkpoint recorded for run ${runId}`);
    });

    it("reverts run branch to prior batch checkpoint ref and prints reverted message", async () => {
      const runId = "r_UNDOSUCCESS";
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();

      // Create branch with 2 commits
      execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "b1.txt"), "batch 1\n", "utf8");
      execFileSync("git", ["add", "b1.txt"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "b1"], { cwd: tmpDir, stdio: "ignore" });
      const b1Sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();

      fs.writeFileSync(path.join(tmpDir, "b2.txt"), "batch 2\n", "utf8");
      execFileSync("git", ["add", "b2.txt"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "b2"], { cwd: tmpDir, stdio: "ignore" });
      const b2Sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();

      execFileSync("git", ["checkout", "main"], { cwd: tmpDir, stdio: "ignore" });

      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        [
          JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }),
          JSON.stringify({
            v: 1,
            seq: 2,
            ts: "2026-10-19T00:00:01Z",
            run_id: runId,
            type: "batch.merged",
            data: { batch: 1, checkpoint_ref: baseSha },
          }),
          JSON.stringify({
            v: 1,
            seq: 3,
            ts: "2026-10-19T00:00:02Z",
            run_id: runId,
            type: "batch.merged",
            data: { batch: 2, checkpoint_ref: b1Sha },
          }),
        ].join("\n") + "\n",
        "utf8"
      );

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await undoCommand.execute(ctx);
      expect(code).toBe(0);
      expect(stdout.getOutput()).toContain(`Reverted substrate/runs/${runId} to ${b1Sha}`);

      const currentRunSha = execFileSync(
        "git",
        ["rev-parse", `substrate/runs/${runId}`],
        { cwd: tmpDir, encoding: "utf8" }
      ).trim();
      expect(currentRunSha).toBe(b1Sha);
    });

    it("refuses when user checkout is on run branch", async () => {
      const runId = "r_UNDOREFUSE";
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();
      execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "b1.txt"), "batch 1\n", "utf8");
      execFileSync("git", ["add", "b1.txt"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "b1"], { cwd: tmpDir, stdio: "ignore" });

      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: "2026-10-19T00:00:00Z",
          run_id: runId,
          type: "batch.merged",
          data: { batch: 1, checkpoint_ref: baseSha },
        }) + "\n",
        "utf8"
      );

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await undoCommand.execute(ctx);
      expect(code).toBe(1);
      expect(stderr.getOutput()).toContain("Error: cannot undo while checkout is on run branch");
    });
  });

  describe("discard command", () => {
    it("exits 2 when run is unknown", async () => {
      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: ["r_NONEXISTENT"],
        stdout,
        stderr,
      };
      const code = await discardCommand.execute(ctx);
      expect(code).toBe(2);
      expect(stderr.getOutput()).toContain("Error: unknown run r_NONEXISTENT");
    });

    it("refuses with exit 1 if active run lock exists and --force is not given", async () => {
      const runId = "r_ACTIVELOCK1";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
        "utf8"
      );
      execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });

      const stateDir = path.join(tmpDir, ".substrate", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, `${runId}.lock`),
        JSON.stringify({ pid: process.pid, run_id: runId, acquired_at: new Date().toISOString() }),
        "utf8"
      );

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await discardCommand.execute(ctx);
      expect(code).toBe(1);
      expect(stderr.getOutput()).toContain(`Error: run ${runId} is active; pass --force to stop it`);
    });

    it("deletes branches, removes worktrees, logs user_cancel if non-terminal, and exits 0", async () => {
      const runId = "r_DISCARDOK01";
      const runDir = path.join(tmpDir, ".substrate", "runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
      const eventsFile = path.join(runDir, "events.jsonl");
      fs.writeFileSync(
        eventsFile,
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
        "utf8"
      );

      execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["branch", `substrate/tasks/${runId}/T1-g1`], { cwd: tmpDir, stdio: "ignore" });

      const wtDir = path.join(tmpDir, ".substrate", "worktrees", runId, "integration");
      fs.mkdirSync(wtDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, "dummy.txt"), "hello", "utf8");

      const stdout = createMockStream();
      const stderr = createMockStream();
      const ctx: CommandContext = {
        cwd: tmpDir,
        flags: {},
        rawArgs: [runId],
        stdout,
        stderr,
      };
      const code = await discardCommand.execute(ctx);
      expect(code).toBe(0);
      expect(stdout.getOutput()).toContain(`Discarded run ${runId}`);

      // Branches deleted?
      const branchList = execFileSync("git", ["branch", "--list"], { cwd: tmpDir, encoding: "utf8" });
      expect(branchList).not.toContain(`substrate/runs/${runId}`);
      expect(branchList).not.toContain(`substrate/tasks/${runId}/T1-g1`);

      // Worktrees directory removed?
      expect(fs.existsSync(path.join(tmpDir, ".substrate", "worktrees", runId))).toBe(false);

      // run.paused user_cancel appended?
      const logged = fs.readFileSync(eventsFile, "utf8");
      expect(logged).toContain('"type":"run.paused"');
      expect(logged).toContain('"reason":"user_cancel"');
      expect(logged).toContain('"seq":2');
    });
  });
});
