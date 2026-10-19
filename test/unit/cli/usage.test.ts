import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import { usageCommand } from "../../../src/cli/commands/usage.js";

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "ledger", "usage-sample.jsonl"),
  "utf8"
);

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

interface ExpectedRow {
  group: string;
  runs: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unknown_cost_rows: number;
}

function expectRow(row: Record<string, number>, expected: ExpectedRow): void {
  expect(row.group).toBe(expected.group);
  expect(row.runs).toBe(expected.runs);
  expect(row.calls).toBe(expected.calls);
  expect(row.input_tokens).toBe(expected.input_tokens);
  expect(row.output_tokens).toBe(expected.output_tokens);
  expect(row.cost_usd).toBeCloseTo(expected.cost_usd, 10);
  expect(row.unknown_cost_rows).toBe(expected.unknown_cost_rows);
}

// Sums of the expected group rows (the totals the command must print).
function expectTotals(totals: Record<string, number>, rows: ExpectedRow[]): void {
  const sum = { runs: 0, calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unknown_cost_rows: 0 };
  for (const row of rows) {
    sum.runs += row.runs;
    sum.calls += row.calls;
    sum.input_tokens += row.input_tokens;
    sum.output_tokens += row.output_tokens;
    sum.cost_usd += row.cost_usd;
    sum.unknown_cost_rows += row.unknown_cost_rows;
  }
  expect(totals.runs).toBe(sum.runs);
  expect(totals.calls).toBe(sum.calls);
  expect(totals.input_tokens).toBe(sum.input_tokens);
  expect(totals.output_tokens).toBe(sum.output_tokens);
  expect(totals.cost_usd).toBeCloseTo(sum.cost_usd, 10);
  expect(totals.unknown_cost_rows).toBe(sum.unknown_cost_rows);
}

let projectDir: string;
let configDir: string;
let stateDir: string;
const savedEnv: Record<string, string | undefined> = {};

// Isolates the settings and global-mirror layers so results are deterministic:
// an empty config dir and a temp state home keep the command off the real user
// environment.
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "substrate-usage-project-"));
  configDir = mkdtempSync(join(tmpdir(), "substrate-usage-config-"));
  stateDir = mkdtempSync(join(tmpdir(), "substrate-usage-state-"));
  for (const key of ["SUBSTRATE_CONFIG_DIR", "XDG_STATE_HOME"]) {
    savedEnv[key] = process.env[key];
    process.env[key] = key === "SUBSTRATE_CONFIG_DIR" ? configDir : stateDir;
  }
});

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  for (const dir of [projectDir, configDir, stateDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedLedger(contents: string): void {
  const ledgerDir = join(projectDir, ".substrate", "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "usage.jsonl"), contents, "utf8");
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(projectDir, ".substrate"), { recursive: true });
  writeFileSync(join(projectDir, ".substrate", "settings.json"), JSON.stringify(settings), "utf8");
}

async function runUsage(flags: Record<string, unknown> = {}, rawArgs: string[] = []) {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const exitCode = await usageCommand.execute({
    cwd: projectDir,
    flags: flags as any,
    rawArgs,
    stdout,
    stderr,
  });
  return { exitCode, out: stdout.getOutput(), err: stderr.getOutput() };
}

describe("usage command", () => {
  it("registers as usage with the cost alias", () => {
    expect(usageCommand.name).toBe("usage");
    expect(usageCommand.aliases).toEqual(["cost"]);
  });

  // One case per --by value (seven), over the fixture. The torn last line of
  // the fixture is skipped, so the calls totals prove skipping in every group.
  const byCases: Array<{ by: string; rows: ExpectedRow[] }> = [
    {
      by: "model",
      rows: [
        { group: "claude-opus-5-5", runs: 1, calls: 1, input_tokens: 2500, output_tokens: 500, cost_usd: 1.1, unknown_cost_rows: 0 },
        { group: "claude-sonnet-5-5", runs: 1, calls: 1, input_tokens: 1200, output_tokens: 300, cost_usd: 0.42, unknown_cost_rows: 0 },
        { group: "opencode-deepseek", runs: 1, calls: 1, input_tokens: 400, output_tokens: 120, cost_usd: 0.08, unknown_cost_rows: 0 },
        { group: "claude-haiku-5-5", runs: 1, calls: 1, input_tokens: 150, output_tokens: 30, cost_usd: 0, unknown_cost_rows: 0 },
        { group: "gemini-3.8-flash", runs: 1, calls: 1, input_tokens: 210, output_tokens: 45, cost_usd: 0, unknown_cost_rows: 1 },
      ],
    },
    {
      by: "provider",
      rows: [
        { group: "claude", runs: 2, calls: 3, input_tokens: 3850, output_tokens: 830, cost_usd: 1.52, unknown_cost_rows: 0 },
        { group: "opencode", runs: 1, calls: 1, input_tokens: 400, output_tokens: 120, cost_usd: 0.08, unknown_cost_rows: 0 },
        { group: "agy", runs: 1, calls: 1, input_tokens: 210, output_tokens: 45, cost_usd: 0, unknown_cost_rows: 1 },
      ],
    },
    {
      by: "role",
      rows: [
        { group: "planner", runs: 1, calls: 1, input_tokens: 2500, output_tokens: 500, cost_usd: 1.1, unknown_cost_rows: 0 },
        { group: "worker", runs: 2, calls: 3, input_tokens: 1810, output_tokens: 465, cost_usd: 0.5, unknown_cost_rows: 1 },
        { group: "reviewer", runs: 1, calls: 1, input_tokens: 150, output_tokens: 30, cost_usd: 0, unknown_cost_rows: 0 },
      ],
    },
    {
      by: "run",
      rows: [
        { group: "run-a", runs: 1, calls: 3, input_tokens: 4100, output_tokens: 920, cost_usd: 1.6, unknown_cost_rows: 0 },
        { group: "run-b", runs: 1, calls: 2, input_tokens: 360, output_tokens: 75, cost_usd: 0, unknown_cost_rows: 1 },
      ],
    },
    {
      by: "task",
      rows: [
        { group: "(none)", runs: 2, calls: 2, input_tokens: 2650, output_tokens: 530, cost_usd: 1.1, unknown_cost_rows: 0 },
        { group: "TASK-A", runs: 1, calls: 2, input_tokens: 1600, output_tokens: 420, cost_usd: 0.5, unknown_cost_rows: 0 },
        { group: "TASK-B", runs: 1, calls: 1, input_tokens: 210, output_tokens: 45, cost_usd: 0, unknown_cost_rows: 1 },
      ],
    },
    {
      by: "class",
      rows: [
        { group: "(none)", runs: 2, calls: 2, input_tokens: 2650, output_tokens: 530, cost_usd: 1.1, unknown_cost_rows: 0 },
        { group: "feature", runs: 1, calls: 1, input_tokens: 1200, output_tokens: 300, cost_usd: 0.42, unknown_cost_rows: 0 },
        { group: "tests", runs: 1, calls: 1, input_tokens: 400, output_tokens: 120, cost_usd: 0.08, unknown_cost_rows: 0 },
        { group: "mechanical", runs: 1, calls: 1, input_tokens: 210, output_tokens: 45, cost_usd: 0, unknown_cost_rows: 1 },
      ],
    },
    {
      by: "day",
      rows: [
        { group: "2026-09-21", runs: 1, calls: 2, input_tokens: 2900, output_tokens: 620, cost_usd: 1.18, unknown_cost_rows: 0 },
        { group: "2026-09-20", runs: 1, calls: 1, input_tokens: 1200, output_tokens: 300, cost_usd: 0.42, unknown_cost_rows: 0 },
        { group: "2026-09-22", runs: 1, calls: 2, input_tokens: 360, output_tokens: 75, cost_usd: 0, unknown_cost_rows: 1 },
      ],
    },
  ];

  for (const testCase of byCases) {
    it(`groups by ${testCase.by}`, async () => {
      seedLedger(FIXTURE);
      const result = await runUsage({ by: testCase.by, outputFormat: "json" });
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.out);
      expect(report.by).toBe(testCase.by);
      expect(report.since).toBeNull();
      expect(report.filters).toEqual({ provider: null, model: null, run: null });
      expect(report.rows.map((row: { group: string }) => row.group)).toEqual(
        testCase.rows.map((row) => row.group)
      );
      for (let i = 0; i < testCase.rows.length; i += 1) {
        expectRow(report.rows[i], testCase.rows[i]);
      }
      expectTotals(report.totals, testCase.rows);
    });
  }

  it("skips blank and torn lines", async () => {
    seedLedger(`\n${FIXTURE}\nnot json\n`);
    const result = await runUsage({ by: "run", outputFormat: "json" });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.out);
    // Only the five fixture rows that parse: run-b still has 2 calls, not the
    // torn or unparsable ones.
    expect(report.totals.calls).toBe(5);
  });

  it("prints the text table with a total row and flags unknown cost", async () => {
    seedLedger(FIXTURE);
    const result = await runUsage({ by: "model" });
    expect(result.exitCode).toBe(0);
    const lines = result.out.split("\n").filter((line) => line.length > 0);
    expect(lines[0]).toBe("group runs calls input output cost");
    expect(lines).toContain("claude-opus-5-5 1 1 2500 500 $1.1000");
    // A group where every row is unknown prints $0.0000 (+ n unknown).
    expect(lines).toContain("gemini-3.8-flash 1 1 210 45 $0.0000 (+ 1 unknown)");
    expect(lines[lines.length - 1]).toBe("total 5 5 4460 995 $1.6000 (+ 1 unknown)");
  });

  it("adds cache columns and cache JSON fields only with --cache", async () => {
    seedLedger(FIXTURE);

    const text = await runUsage({ by: "role", cache: true });
    const lines = text.out.split("\n").filter((line) => line.length > 0);
    expect(lines[0]).toBe("group runs calls input output cost cache_read cache_write reasoning");
    expect(lines).toContain("worker 2 3 1810 465 $0.5000 (+ 1 unknown) 800 100 150");

    const json = await runUsage({ by: "model", cache: true, outputFormat: "json" });
    const report = JSON.parse(json.out);
    const sonnet = report.rows.find((row: { group: string }) => row.group === "claude-sonnet-5-5");
    expect(sonnet.cache_read_tokens).toBe(800);
    expect(sonnet.cache_write_tokens).toBe(100);
    expect(sonnet.reasoning_tokens).toBe(150);

    const noCache = JSON.parse((await runUsage({ by: "model", outputFormat: "json" })).out);
    expect(Object.keys(noCache.rows[0])).not.toContain("cache_read_tokens");
  });

  it("drops entries before the --since cut-off", async () => {
    seedLedger(FIXTURE);
    const result = await runUsage({ by: "day", since: "2026-09-21", outputFormat: "json" });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.since).toBe("2026-09-21");
    expect(report.rows.map((row: { group: string }) => row.group)).toEqual(["2026-09-21", "2026-09-22"]);
  });

  it("applies --provider, --model and --run filters before grouping", async () => {
    seedLedger(FIXTURE);
    const result = await runUsage({ by: "role", provider: "claude", model: "claude-opus-5-5", outputFormat: "json" });
    const report = JSON.parse(result.out);
    expect(report.filters.provider).toBe("claude");
    expect(report.filters.model).toBe("claude-opus-5-5");
    expect(report.rows.length).toBe(1);
    expect(report.rows[0].group).toBe("planner");
  });

  it("treats a positional run id as the --run shorthand", async () => {
    seedLedger(FIXTURE);
    const result = await runUsage({ by: "run", outputFormat: "json" }, ["run-b"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.filters.run).toBe("run-b");
    expect(report.rows.length).toBe(1);
    expect(report.rows[0].group).toBe("run-b");
  });

  it("prints no usage recorded for zero entries and exits 0", async () => {
    seedLedger("");
    const text = await runUsage({ by: "role" });
    expect(text.exitCode).toBe(0);
    expect(text.out).toBe("no usage recorded\n");

    seedLedger(FIXTURE);
    const filtered = await runUsage({ by: "role", model: "model-never-used", outputFormat: "json" });
    expect(filtered.exitCode).toBe(0);
    const report = JSON.parse(filtered.out);
    expect(report.rows).toEqual([]);
    expect(report.totals.cost_usd).toBe(0);
  });

  it("prints no usage recorded for a run with no rows", async () => {
    seedLedger(FIXTURE);
    const result = await runUsage({ by: "run" }, ["run-z"]);
    expect(result.exitCode).toBe(0);
    expect(result.out).toBe("no usage recorded\n");
  });

  it("rejects an unknown --by with exit 2", async () => {
    seedLedger(FIXTURE);
    const text = await runUsage({ by: "cost_center" });
    expect(text.exitCode).toBe(2);
    expect(text.err).toContain("Error: invalid --by 'cost_center'");

    const json = await runUsage({ by: "cost_center", outputFormat: "json" });
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.out)).toEqual({ error: "invalid --by 'cost_center'" });
  });

  it("rejects an invalid --since with exit 2", async () => {
    seedLedger(FIXTURE);
    const result = await runUsage({ by: "model", since: "last week" });
    expect(result.exitCode).toBe(2);
    expect(result.err).toContain("Error: invalid --since 'last week' (use 7d or YYYY-MM-DD)");
  });

  it("prints no global mirror when the settings turn the mirror off", async () => {
    seedLedger(FIXTURE);
    writeSettings({ usage: { global: false } });
    const result = await runUsage({ allProjects: true, outputFormat: "json" });
    expect(result.exitCode).toBe(0);
    expect(result.out).toBe("no global mirror\n");
  });

  it("rebuilds a run's ledger lines from its events before the report", async () => {
    seedLedger(
      [
        JSON.parse(FIXTURE.split("\n")[0]),
        {
          v: 1,
          ts: "2026-09-22T12:30:00Z",
          project: projectDir,
          run_id: "run-b",
          role: "worker",
          backend: "agy",
          model: "gemini-3.8-flash",
          input_tokens: 999,
          output_tokens: 999,
          cost_usd: 0.9,
          cost_source: "reported",
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    );
    writeSettings({ usage: { global: false } });

    const runDir = join(projectDir, ".substrate", "runs", "run-b");
    mkdirSync(runDir, { recursive: true });
    const event = {
      v: 1,
      seq: 2,
      ts: "2026-09-22T11:15:00Z",
      run_id: "run-b",
      type: "usage.recorded",
      data: {
        role: "worker",
        class: "mechanical",
        record: {
          backend: "agy",
          model: "gemini-3.8-flash",
          input_tokens: 210,
          output_tokens: 45,
          cost_usd: 0.2,
          cost_source: "computed",
        },
      },
    };
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");

    const result = await runUsage({ by: "run", rebuild: true });
    expect(result.exitCode).toBe(0);
    const lines = result.out.split("\n").filter((line) => line.length > 0);
    expect(lines[0]).toBe("rebuilt 1 line(s) from 1 run(s)");
    expect(lines[1]).toBe("group runs calls input output cost");
    expect(lines[2]).toBe("run-a 1 1 1200 300 $0.4200");
    // The rebuilt run-b row replaces the pre-existing one.
    expect(lines[3]).toBe("run-b 1 1 210 45 $0.2000");

    const fileLines = readFileSync(join(projectDir, ".substrate", "ledger", "usage.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(fileLines.length).toBe(2);
    expect(JSON.parse(fileLines[1]).cost_usd).toBe(0.2);
  });
});
