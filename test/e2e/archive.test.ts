import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { runSubstrate } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";

describe("E2E Archive, History, GC (R4.4)", () => {
  it("archives finished run, archives failed run, and history lists both", () => {
    const repo = createE2ERepo({
      "src/app.txt": "initial app\n",
    });

    // (a) a run that finishes (`run` with fake solo scenario, exit 0) produces
    // .substrate/archive/v1/<run_id>/summary.md and one INDEX line
    const resA = runSubstrate({
      repo,
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

    expect(resA.exitCode).toBe(0);
    const finishEvA = [...resA.events].reverse().find((e) => e.type === "run.finished");
    expect(finishEvA).toBeDefined();
    expect((finishEvA?.data as any)?.exit_code).toBe(0);

    const runIdA = finishEvA?.run_id!;
    expect(runIdA).toBeDefined();

    const archiveDirA = path.join(repo.dir, ".substrate", "archive", "v1", runIdA);
    const summaryPathA = path.join(archiveDirA, "summary.md");
    expect(fs.existsSync(summaryPathA)).toBe(true);

    const summaryContentA = fs.readFileSync(summaryPathA, "utf8");
    expect(summaryContentA).toContain("Status: finished");
    expect(summaryContentA).toContain("Exit code: 0");

    const indexPath = path.join(repo.dir, ".substrate", "archive", "v1", "INDEX.md");
    expect(fs.existsSync(indexPath)).toBe(true);
    let indexContent = fs.readFileSync(indexPath, "utf8");
    let indexLines = indexContent.split("\n").filter((l) => l.trim().length > 0);
    expect(indexLines.length).toBe(1);
    expect(indexLines[0]).toContain(runIdA);
    expect(indexLines[0]).toContain("finished");

    // (b) a run that fails (fake scenario with a failing verify and no fix, exit 1)
    // also archives with status failed
    const resB = runSubstrate({
      repo,
      scenario: {
        calls: [
          {
            edits: { "wrong.txt": "wrong\n" },
            reply: "DONE",
          },
          {
            reply: "cannot fix",
          },
        ],
      },
      args: [
        "run",
        "--mode",
        "solo",
        "--verify",
        "test -f required.txt",
        "fail verify",
      ],
    });

    expect(resB.exitCode).toBe(1);
    const finishEvB = [...resB.events].reverse().find((e) => e.type === "run.finished");
    expect(finishEvB).toBeDefined();
    expect((finishEvB?.data as any)?.exit_code).toBe(1);

    const runIdB = finishEvB?.run_id!;
    expect(runIdB).toBeDefined();
    expect(runIdB).not.toBe(runIdA);

    const archiveDirB = path.join(repo.dir, ".substrate", "archive", "v1", runIdB);
    const summaryPathB = path.join(archiveDirB, "summary.md");
    expect(fs.existsSync(summaryPathB)).toBe(true);

    const summaryContentB = fs.readFileSync(summaryPathB, "utf8");
    expect(summaryContentB).toContain("Status: failed");
    expect(summaryContentB).toContain("Exit code: 1");

    indexContent = fs.readFileSync(indexPath, "utf8");
    indexLines = indexContent.split("\n").filter((l) => l.trim().length > 0);
    expect(indexLines.length).toBe(2);
    expect(indexLines.some((l) => l.includes(runIdA) && l.includes("finished"))).toBe(true);
    expect(indexLines.some((l) => l.includes(runIdB) && l.includes("failed"))).toBe(true);

    // (c) history --output-format json lists both
    const resC = runSubstrate({
      repo,
      args: ["history", "--output-format", "json"],
    });

    expect(resC.exitCode).toBe(0);
    const historyData = JSON.parse(resC.stdout);
    expect(historyData).toHaveProperty("version", "v1");
    expect(historyData).toHaveProperty("runs");
    expect(Array.isArray(historyData.runs)).toBe(true);
    expect(historyData.runs.length).toBe(2);

    const runAInHistory = historyData.runs.find((r: any) => r.run_id === runIdA);
    const runBInHistory = historyData.runs.find((r: any) => r.run_id === runIdB);

    expect(runAInHistory).toBeDefined();
    expect(runAInHistory.status).toBe("finished");
    expect(runAInHistory.dir).toBe(archiveDirA);

    expect(runBInHistory).toBeDefined();
    expect(runBInHistory.status).toBe("failed");
    expect(runBInHistory.dir).toBe(archiveDirB);

    resA.cleanup();
  });
});
