import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";

// Isolates the settings and state layers so the stats come only from this
// repo's project ledger, on any machine.
function isolatedEnv(): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), "substrate-stats-config-"));
  const stateDir = mkdtempSync(join(tmpdir(), "substrate-stats-state-"));
  return {
    SUBSTRATE_CONFIG_DIR: configDir,
    SUBSTRATE_SETTINGS: "",
    SUBSTRATE_PROJECT_DIR: "",
    SUBSTRATE_MODEL: "",
    SUBSTRATE_WORKER_MODEL: "",
    SUBSTRATE_OUTPUT_FORMAT: "",
    SUBSTRATE_EXECUTION: "",
    SUBSTRATE_SETTINGS_CONTENT: "",
    SUBSTRATE_PERMISSION_MODE: "",
    XDG_STATE_HOME: stateDir,
  };
}

function runDirNames(repoDir: string): string[] {
  const base = join(repoDir, ".substrate", "runs");
  return existsSync(base) ? readdirSync(base).sort() : [];
}

function eventTypesIn(repoDir: string, runDir: string): string[] {
  return readFileSync(join(repoDir, ".substrate", "runs", runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { type: string }).type);
}

interface LedgerRow {
  model: string;
  backend: string;
  task_id?: string;
  role: string;
}

function readLedger(repoDir: string): LedgerRow[] {
  return readFileSync(join(repoDir, ".substrate", "ledger", "usage.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerRow);
}

describe("E2E models --stats after two real solo runs", () => {
  it(
    "reports the fake model with two tasks, first-pass 0.5 and heal 0.5, in JSON and text",
    () => {
      const repo = createE2ERepo({ "src/main.txt": "initial\n" });
      const env = isolatedEnv();

      // Run 1: attempt 1 passes verify.
      const before1 = runDirNames(repo.dir);
      const run1 = runSubstrate({
        repo,
        scenario: {
          calls: [
            {
              edits: { "feature.txt": "new feature\n" },
              reply: "DONE",
            },
          ],
        },
        args: ["run", "--mode", "solo", "--verify", "test -f feature.txt", "create feature.txt"],
        env,
      });

      const run1Dirs = runDirNames(repo.dir).filter((d) => !before1.includes(d));
      // Run 2: attempt 1 fails verify, the one heal fixes it.
      const run2 = runSubstrate({
        repo,
        scenario: {
          calls: [
            {
              edits: { "feature.txt": "the-wrong-line\n" },
              reply: "appended a line without the marker\nDONE",
            },
            {
              edits: { "feature.txt": "the-wrong-line\nmarker\n" },
              reply: "the heal adds the marker\nDONE",
            },
          ],
        },
        args: ["run", "--mode", "solo", "--verify", "grep -q marker feature.txt", "add the marker"],
        env,
      });

      try {
        expect(run1.exitCode).toBe(0);
        expect(run2.exitCode).toBe(0);
        const run2Dirs = runDirNames(repo.dir).filter((d) => !before1.includes(d) && !run1Dirs.includes(d));
        expect(run2Dirs).toHaveLength(1);
        expect(eventTypesIn(repo.dir, run2Dirs[0]).filter((t) => t === "task.healing")).toHaveLength(1);

        // The model is whatever the runs wrote to the ledger; it is not guessed.
        const taskRows = readLedger(repo.dir).filter((row) => row.task_id === "SOLO" && row.role === "worker");
        expect(taskRows.length).toBeGreaterThanOrEqual(2);
        const models = new Set(taskRows.map((row) => row.model));
        expect(models.size).toBe(1);
        const fakeModel = [...models][0];
        expect(fakeModel.length).toBeGreaterThan(0);

        const json = runSubstrate({
          repo,
          args: ["models", "--stats", "--output-format", "json"],
          env,
        });
        expect(json.exitCode).toBe(0);
        expect(json.stdout.trim().split("\n")).toHaveLength(1);

        const report = JSON.parse(json.stdout);
        expect(Array.isArray(report.stats)).toBe(true);
        const row = report.stats.find((r: { model: string }) => r.model === fakeModel);
        expect(row).toBeDefined();
        expect(row.tasks).toBeGreaterThanOrEqual(2);
        expect(row.first_pass_rate).not.toBeNull();
        // Two generations: run 1 passes on attempt 1, run 2 needs one heal.
        expect(row.tasks).toBe(2);
        expect(row.first_pass_rate).toBe(0.5);
        expect(row.heal_rate).toBe(0.5);

        const text = runSubstrate({
          repo,
          args: ["models", "--stats"],
          env,
        });
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain(fakeModel);
        expect(text.stdout).toContain("all models");
      } finally {
        run1.cleanup();
        run2.cleanup();
      }
    },
    180000
  );
});
