import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";

describe("E2E merge, undo, discard (R3.7)", () => {
  it("(1) merge of a finished run exits 0 and HEAD gains a merge commit", () => {
    const repo = createE2ERepo({
      "README.md": "# Main branch\n",
    });

    const runId = "r_MERGEFINISH";
    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      [
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }),
        JSON.stringify({
          v: 1,
          seq: 2,
          ts: "2026-10-19T00:00:01Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 0 },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    // Create branch substrate/runs/r_MERGEFINISH with a new file
    execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });
    writeFileSync(join(repo.dir, "feature.txt"), "feature content\n", "utf8");
    execFileSync("git", ["add", "feature.txt"], { cwd: repo.dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add feature"], { cwd: repo.dir, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: repo.dir, stdio: "ignore" });

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();

    const res = runSubstrate({
      repo,
      args: ["merge", runId],
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`Merged substrate/runs/${runId} into main`);

    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(headAfter).not.toBe(headBefore);

    // Verify merge commit parents
    const parents = execFileSync("git", ["rev-parse", "HEAD^@"], { cwd: repo.dir, encoding: "utf8" })
      .trim()
      .split(/\s+/);
    expect(parents.length).toBe(2);
    expect(existsSync(join(repo.dir, "feature.txt"))).toBe(true);
    res.cleanup();
  });

  it("(2) merge of a failed run exits 1 with the refusal text", () => {
    const repo = createE2ERepo({
      "README.md": "# Main branch\n",
    });

    const runId = "r_MERGEFAILED";
    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      [
        JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }),
        JSON.stringify({
          v: 1,
          seq: 2,
          ts: "2026-10-19T00:00:01Z",
          run_id: runId,
          type: "run.finished",
          data: { exit_code: 1, status: "failed" },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });

    const res = runSubstrate({
      repo,
      args: ["merge", runId],
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`Error: run ${runId} did not finish successfully; not merged`);
    res.cleanup();
  });

  it("(3) merge --dry-run changes nothing", () => {
    const repo = createE2ERepo({
      "README.md": "# Main branch\n",
    });

    const runId = "r_MERGEDRYRUN";
    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
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

    execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });
    writeFileSync(join(repo.dir, "dry.txt"), "dry run content\n", "utf8");
    execFileSync("git", ["add", "dry.txt"], { cwd: repo.dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add dry file"], { cwd: repo.dir, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: repo.dir, stdio: "ignore" });

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();

    const res = runSubstrate({
      repo,
      args: ["merge", runId, "--dry-run"],
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`would merge 1 commit(s) from substrate/runs/${runId} into main`);

    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
    expect(existsSync(join(repo.dir, "dry.txt"))).toBe(false);
    res.cleanup();
  });

  it("(4) merge with a dirty tracked file exits 1", () => {
    const repo = createE2ERepo({
      "README.md": "# Main branch\n",
    });

    const runId = "r_MERGEDIRTY1";
    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
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

    execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });

    // Dirty tracked file
    writeFileSync(join(repo.dir, "README.md"), "# Dirty modification\n", "utf8");

    const res = runSubstrate({
      repo,
      args: ["merge", runId],
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Error: uncommitted changes to tracked files; commit or stash first");
    res.cleanup();
  });

  it("(5) undo after two batches moves the run branch back one checkpoint", () => {
    const repo = createE2ERepo({
      "README.md": "# Base\n",
    });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();

    const runId = "r_UNDOBATCH2";
    execFileSync("git", ["checkout", "-b", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });

    writeFileSync(join(repo.dir, "batch1.txt"), "batch 1\n", "utf8");
    execFileSync("git", ["add", "batch1.txt"], { cwd: repo.dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "batch 1 commit"], { cwd: repo.dir, stdio: "ignore" });
    const b1Sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();

    writeFileSync(join(repo.dir, "batch2.txt"), "batch 2\n", "utf8");
    execFileSync("git", ["add", "batch2.txt"], { cwd: repo.dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "batch 2 commit"], { cwd: repo.dir, stdio: "ignore" });
    const b2Sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();

    execFileSync("git", ["checkout", "main"], { cwd: repo.dir, stdio: "ignore" });

    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
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

    const res = runSubstrate({
      repo,
      args: ["undo", runId],
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`Reverted substrate/runs/${runId} to ${b1Sha}`);

    const runBranchAfter = execFileSync("git", ["rev-parse", `substrate/runs/${runId}`], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim();
    expect(runBranchAfter).toBe(b1Sha);
    expect(runBranchAfter).not.toBe(b2Sha);
    res.cleanup();
  });

  it("(6) undo on a run with no checkpoint exits 1", () => {
    const repo = createE2ERepo({
      "README.md": "# Base\n",
    });

    const runId = "r_UNDONOCKPT";
    execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });

    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
      "utf8"
    );

    const res = runSubstrate({
      repo,
      args: ["undo", runId],
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`Error: no checkpoint recorded for run ${runId}`);
    res.cleanup();
  });

  it("(7) discard removes the worktree directory and branches", () => {
    const repo = createE2ERepo({
      "README.md": "# Base\n",
    });

    const runId = "r_DISCARDBRA";
    execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });
    execFileSync("git", ["branch", `substrate/tasks/${runId}/T1-g1`], { cwd: repo.dir, stdio: "ignore" });

    const wtDir = join(repo.dir, ".substrate", "worktrees", runId, "integration");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "temp.txt"), "worktree temp\n", "utf8");

    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
      "utf8"
    );

    const res = runSubstrate({
      repo,
      args: ["discard", runId],
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`Discarded run ${runId}`);
    expect(existsSync(join(repo.dir, ".substrate", "worktrees", runId))).toBe(false);

    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo.dir, encoding: "utf8" });
    expect(branches).not.toContain(`substrate/runs/${runId}`);
    expect(branches).not.toContain(`substrate/tasks/${runId}/T1-g1`);
    res.cleanup();
  });

  it("(8) discard of an active run exits 1 without --force", () => {
    const repo = createE2ERepo({
      "README.md": "# Base\n",
    });

    const runId = "r_DISCARDLOCK";
    execFileSync("git", ["branch", `substrate/runs/${runId}`], { cwd: repo.dir, stdio: "ignore" });

    const runDir = join(repo.dir, ".substrate", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({ v: 1, seq: 1, ts: "2026-10-19T00:00:00Z", run_id: runId, type: "run.started" }) + "\n",
      "utf8"
    );

    const stateDir = join(repo.dir, ".substrate", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `${runId}.lock`),
      JSON.stringify({ pid: process.pid, run_id: runId, acquired_at: new Date().toISOString() }),
      "utf8"
    );

    const res = runSubstrate({
      repo,
      args: ["discard", runId],
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`Error: run ${runId} is active; pass --force to stop it`);
    res.cleanup();
  });
});
