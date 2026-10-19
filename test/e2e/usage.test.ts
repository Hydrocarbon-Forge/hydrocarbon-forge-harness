import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { runSubstrate } from "./helpers/run-substrate.js";

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ledger", "usage-sample.jsonl"),
  "utf8"
);

// Isolates the settings and global-mirror layers so results are deterministic
// on any machine: an empty config dir, and empty strings neutralize any
// inherited overrides.
function isolatedEnv(): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), "substrate-usage-config-"));
  const stateDir = mkdtempSync(join(tmpdir(), "substrate-usage-state-"));
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

// The worker row of the fixture, expected identically from both the usage
// command and its cost alias. Every number here is the sum of the fixture's
// own fields; no price is computed by the command.
const WORKER_ROW = {
  group: "worker",
  runs: 2,
  calls: 3,
  input_tokens: 1810,
  output_tokens: 465,
  cost_usd: 0.5,
  unknown_cost_rows: 1,
};

describe("E2E usage command", () => {
  it("reports the fixture through usage with a non-zero worker row (JSON)", () => {
    const res = runSubstrate({
      files: { ".substrate/ledger/usage.jsonl": FIXTURE },
      args: ["usage", "--by", "role", "--output-format", "json"],
      env: isolatedEnv(),
    });
    try {
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim().split("\n")).toHaveLength(1);

      const report = JSON.parse(res.stdout);
      expect(report.by).toBe("role");
      const worker = report.rows.find((row: { group: string }) => row.group === WORKER_ROW.group);
      expect(worker).toBeDefined();
      expect(worker.input_tokens).not.toBe(0);
      expect(worker.runs).toBe(WORKER_ROW.runs);
      expect(worker.calls).toBe(WORKER_ROW.calls);
      expect(worker.input_tokens).toBe(WORKER_ROW.input_tokens);
      expect(worker.output_tokens).toBe(WORKER_ROW.output_tokens);
      expect(worker.cost_usd).toBeCloseTo(WORKER_ROW.cost_usd, 10);
      expect(worker.unknown_cost_rows).toBe(WORKER_ROW.unknown_cost_rows);

      expect(report.totals.calls).toBe(5);
      expect(report.totals.cost_usd).toBeCloseTo(1.6, 10);
    } finally {
      res.cleanup();
    }
  });

  it("cost is the usage alias and prints the same worker row in text mode", () => {
    const res = runSubstrate({
      files: { ".substrate/ledger/usage.jsonl": FIXTURE },
      args: ["cost", "--by", "role"],
      env: isolatedEnv(),
    });
    try {
      expect(res.exitCode).toBe(0);
      const lines = res.stdout.split("\n").filter((line) => line.length > 0);
      expect(lines[0]).toBe("group runs calls input output cost");

      // The same row as the JSON case above, formatted as text.
      const costCell = `$${WORKER_ROW.cost_usd.toFixed(4)} (+ ${WORKER_ROW.unknown_cost_rows} unknown)`;
      const expected = `${WORKER_ROW.group} ${WORKER_ROW.runs} ${WORKER_ROW.calls} ${WORKER_ROW.input_tokens} ${WORKER_ROW.output_tokens} ${costCell}`;
      expect(lines).toContain(expected);
    } finally {
      res.cleanup();
    }
  });

  it("accepts a positional run id as the --run shorthand through the built CLI", () => {
    const res = runSubstrate({
      files: { ".substrate/ledger/usage.jsonl": FIXTURE },
      args: ["usage", "run-b", "--by", "run", "--output-format", "json"],
      env: isolatedEnv(),
    });
    try {
      expect(res.exitCode).toBe(0);
      const report = JSON.parse(res.stdout);
      expect(report.filters.run).toBe("run-b");
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].group).toBe("run-b");
    } finally {
      res.cleanup();
    }
  });
});
