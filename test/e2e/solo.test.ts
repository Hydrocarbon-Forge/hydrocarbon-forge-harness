import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runSubstrate } from "./helpers/run-substrate.js";

describe("Solo mode E2E", () => {
  it("(a) run --mode solo --verify 'test -f feature.txt' creates commit on run branch and leaves user branch head unchanged", () => {
    const res = runSubstrate({
      files: {
        "src/main.txt": "initial\n",
      },
      scenario: {
        calls: [
          {
            edits: { "feature.txt": "new feature\n" },
            reply: "DONE",
          },
        ],
      },
      args: [
        "run",
        "--mode",
        "solo",
        "--verify",
        "test -f feature.txt",
        "create feature.txt",
      ],
    });

    try {
      expect(res.exitCode).toBe(0);
      const finishEv = [...res.events].reverse().find((e) => e.type === "run.finished");
      expect(finishEv).toBeDefined();
      expect((finishEv?.data as any)?.exit_code).toBe(0);

      const runId = finishEv?.run_id;
      expect(runId).toBeDefined();

      const runBranch = `substrate/runs/${runId}`;

      // Run branch has one commit on top of the base
      const revCount = execFileSync(
        "git",
        ["rev-list", "--count", "--first-parent", `HEAD..${runBranch}`],
        { cwd: res.repoDir, encoding: "utf8" }
      ).trim();
      expect(parseInt(revCount, 10)).toBe(1);

      // And exactly one non-merge task commit
      const taskCommits = execFileSync(
        "git",
        ["rev-list", "--count", "--no-merges", `HEAD..${runBranch}`],
        { cwd: res.repoDir, encoding: "utf8" }
      ).trim();
      expect(parseInt(taskCommits, 10)).toBe(1);

      // Verify feature.txt exists on the run branch commit
      const fileOnRunBranch = execFileSync(
        "git",
        ["show", `${runBranch}:feature.txt`],
        { cwd: res.repoDir, encoding: "utf8" }
      );
      expect(fileOnRunBranch).toBe("new feature\n");

      // The user's branch head is unchanged
      expect(existsSync(join(res.repoDir, "feature.txt"))).toBe(false);
      const trackedStatus = execFileSync("git", ["status", "--porcelain", "-uno"], {
        cwd: res.repoDir,
        encoding: "utf8",
      }).trim();
      expect(trackedStatus).toBe("");

      // User's HEAD is still at the base commit (parent of the feature commit)
      const userHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: res.repoDir,
        encoding: "utf8",
      }).trim();
      const baseOfRun = execFileSync("git", ["rev-parse", `${runBranch}^1`], {
        cwd: res.repoDir,
        encoding: "utf8",
      }).trim();
      expect(userHead).toBe(baseOfRun);
    } finally {
      res.cleanup();
    }
  });

  it("(b) with no --verify in a directory with no ecosystem file, stderr contains warning and exit is 0", () => {
    const res = runSubstrate({
      files: {
        "notes.txt": "just notes\n",
      },
      scenario: {
        calls: [
          {
            edits: {},
            reply: "DONE",
          },
        ],
      },
      args: [
        "run",
        "--mode",
        "solo",
        "solo run without verify",
      ],
    });

    try {
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toContain(
        "warning: no verify commands; only scope and budget checks apply"
      );
      const finishEv = [...res.events].reverse().find((e) => e.type === "run.finished");
      expect(finishEv).toBeDefined();
      expect((finishEv?.data as any)?.exit_code).toBe(0);
    } finally {
      res.cleanup();
    }
  });

  it("(c) auto mode routed to solo with no --verify warns the same way as an explicit solo run", () => {
    const res = runSubstrate({
      files: {
        "notes.txt": "just notes\n",
      },
      scenario: {
        calls: [
          {
            edits: { "notes.txt": "fixed\n" },
            reply: "DONE",
          },
        ],
      },
      args: [
        "run",
        "fix typo in notes.txt",
      ],
    });

    try {
      expect(res.exitCode).toBe(0);
      const routed = res.events.find((e) => e.type === "run.routed");
      expect(routed?.data).toMatchObject({ mode: "solo" });
      expect(res.stderr).toContain(
        "warning: no verify commands; only scope and budget checks apply"
      );
    } finally {
      res.cleanup();
    }
  });
});
