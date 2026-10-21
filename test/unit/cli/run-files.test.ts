import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { followLines, followStderrLine, progressLine } from "../../../src/cli/progress.js";
import { ProgressLog, writeOutcome } from "../../../src/cli/run-files.js";

// R10.2: the progress log and the outcome files a run leaves beside its events, tested without a run.

const RUN = "r_TESTRUN00002";

describe("R10.2: the progress lines and announcements", () => {
  it("a progress line is the elapsed time in brackets, the body, and a newline", () => {
    expect(progressLine("run started", 1_000 + 65_000, 1_000)).toBe("[01:05] run started\n");
  });

  it("the announcement names watch and the progress log, and the stderr line names watch", () => {
    expect(followLines("r_X")).toEqual([
      "follow this run from another terminal: substrate watch r_X",
      "log: .substrate/runs/r_X/progress.log",
    ]);
    expect(followStderrLine("r_X", "started")).toBe("run r_X started; follow it with: substrate watch r_X\n");
    expect(followStderrLine("r_X", "resumed")).toBe("run r_X resumed; follow it with: substrate watch r_X\n");
  });
});

describe("R10.2: progress.log and the outcome files are best effort", () => {
  it("a log whose path is a directory warns once and does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-unit-log-"));
    try {
      mkdirSync(join(dir, "progress.log"));
      const warnings: string[] = [];
      const log = new ProgressLog(dir, (m) => warnings.push(m));
      expect(() => {
        log.header("run r_X started now");
        log.append("[00:00] one\n");
        log.append("[00:00] two\n");
      }).not.toThrow();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("is not written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a log appends in order, one line per write", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-unit-log-ok-"));
    try {
      const log = new ProgressLog(join(dir, "run"), () => {});
      log.header("run r_X started T");
      log.append("[00:00] a\n");
      log.header("resumed T2");
      expect(readFileSync(join(dir, "run", "progress.log"), "utf8")).toBe(
        "# run r_X started T\n[00:00] a\n# resumed T2\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeOutcome writes summary.txt and result.json, and a missing directory is created", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-unit-outcome-"));
    try {
      const runDir = join(dir, "runs", RUN);
      writeOutcome(runDir, "--- Run Summary ---\n", { status: "finished" });
      expect(readFileSync(join(runDir, "summary.txt"), "utf8")).toBe("--- Run Summary ---\n");
      expect(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"))).toEqual({ status: "finished" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeOutcome never throws when its directory cannot be a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-unit-outcome-fail-"));
    try {
      const blocker = join(dir, "runs");
      writeFileSync(blocker, "not a directory", "utf8");
      expect(() => writeOutcome(join(blocker, RUN), "x", {})).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

