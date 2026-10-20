import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Gate G5 tests. They run scripts/gate-g5.mjs over temporary roots with hand-written
// record files and a hand-written --status file, so they need neither SUBSTRATE_LIVE
// nor any real harness binary.

const scriptPath = path.resolve("scripts/gate-g5.mjs");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      status: err.status ?? -1,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
    };
  }
}

interface Rec {
  harness: string;
  version: string;
  model: string;
  run_id: string;
  status: "passed" | "failed" | "skipped";
  exit_code: number | null;
  cost_usd: number | null;
  ts: string;
}

function rec(harness: string, status: Rec["status"], ts: string, overrides: Partial<Rec> = {}): Rec {
  const pins: Record<string, string> = { claude: "2.1.304", opencode: "2.0.21", agy: "1.4.2" };
  return {
    harness,
    version: pins[harness] ?? "0.0.0",
    model: `${harness}-model`,
    run_id: `r_${harness.toUpperCase()}${status.toUpperCase()}`,
    status,
    exit_code: status === "skipped" ? null : status === "passed" ? 0 : 1,
    cost_usd: status === "skipped" ? null : 0.0123,
    ts,
    ...overrides,
  };
}

const T1 = "2026-10-18T10:00:00.000Z";
const T2 = "2026-10-18T11:00:00.000Z";
const T3 = "2026-10-18T12:00:00.000Z";

const PINS = { claude: "2.1.304", opencode: "2.0.21", agy: "1.4.2" };

function statusAll(installed: Record<string, boolean> = {}, versions: Record<string, string> = {}) {
  return ["claude", "opencode", "agy"].map((harness) => ({
    harness,
    installed: installed[harness] ?? true,
    version: versions[harness] ?? PINS[harness as keyof typeof PINS],
    pin: PINS[harness as keyof typeof PINS],
  }));
}

describe("gate-g5 script", () => {
  let root: string;
  let statusFile: string;
  let recordFile: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "gate-g5-"));
    statusFile = path.join(root, "status.json");
    recordFile = path.join(root, ".substrate", "ledger", "live-smoke.json");
    writeFileSync(statusFile, JSON.stringify(statusAll()));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeRecords(records: unknown) {
    mkdirSync(path.dirname(recordFile), { recursive: true });
    writeFileSync(recordFile, typeof records === "string" ? records : JSON.stringify(records));
  }

  function gate(extraStatus?: unknown) {
    if (extraStatus !== undefined) {
      writeFileSync(statusFile, JSON.stringify(extraStatus));
    }
    return run(["--root", root, "--status", statusFile]);
  }

  function passAll(ts = T1) {
    return ["claude", "opencode", "agy"].map((h) => rec(h, "passed", ts));
  }

  it("no records exits 1 and names every installed harness", () => {
    const res = gate();
    expect(res.status).toBe(1);
    for (const h of ["claude", "opencode", "agy"]) {
      expect(res.stdout).toContain(`GATE ${h} `);
    }
    expect(res.stdout).toMatch(/^FAIL: 3 problem\(s\)$/m);
  });

  it("a passed record at the current pin for every installed harness exits 0 and shows model and cost", () => {
    writeRecords(passAll());
    const res = gate();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^OK$/m);
    expect(res.stdout).not.toMatch(/^GATE /m);
    expect(res.stdout).toContain("claude-model");
    expect(res.stdout).toContain("opencode-model");
    expect(res.stdout).toContain("agy-model");
    expect(res.stdout).toContain("$0.0123");
    expect(res.stdout).toContain("r_CLAUDEPASSED");
  });

  it("a failed latest record exits 1", () => {
    writeRecords([...passAll(T1), rec("claude", "failed", T2)]);
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^GATE claude /m);
    expect(res.stdout).not.toMatch(/^GATE opencode /m);
  });

  it("only a skipped record exits 1", () => {
    writeRecords(["claude", "opencode", "agy"].map((h) => rec(h, "skipped", T1)));
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^GATE claude /m);
    expect(res.stdout).toMatch(/^FAIL: 3 problem\(s\)$/m);
  });

  it("no installed harness exits 1 with the exact message", () => {
    writeFileSync(statusFile, JSON.stringify(statusAll({ claude: false, opencode: false, agy: false })));
    const res = run(["--root", root, "--status", statusFile]);
    expect(res.status).toBe(1);
    expect(res.stdout.split("\n")).toContain("no installed harness; nothing recorded");
  });

  it("a passed record at an old version exits 1 when the pin has changed", () => {
    const old = passAll(T1).map((r) => (r.harness === "claude" ? { ...r, version: "2.1.200" } : r));
    writeRecords(old);
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^GATE claude /m);
    expect(res.stdout).not.toMatch(/^GATE opencode /m);
  });

  it("a passed record followed by a later skipped record exits 1 with the skipped line", () => {
    writeRecords([...passAll(T1), rec("claude", "skipped", T2), rec("opencode", "skipped", T2), rec("agy", "skipped", T2)]);
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(`GATE claude latest live record is skipped (${T2}): run npm run test:live`);
    expect(res.stdout).toMatch(/^FAIL: 3 problem\(s\)$/m);
    expect(res.stdout).not.toMatch(/^OK$/m);
  });

  it("a skipped record with version unknown as the only record of an installed harness exits 1 with the skipped line", () => {
    writeRecords([
      { ...rec("claude", "skipped", T1), version: "unknown" },
      rec("opencode", "passed", T1),
      rec("agy", "passed", T1),
    ]);
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(`GATE claude latest live record is skipped (${T1}): run npm run test:live`);
    expect(res.stdout).toMatch(/^FAIL: 1 problem\(s\)$/m);
    expect(res.stdout).toMatch(/^claude\s.*\sskipped$/m);
  });

  it("a skipped record followed by a passed record at the pin exits 0", () => {
    writeRecords([
      { ...rec("claude", "skipped", T1), version: "unknown" },
      rec("claude", "passed", T2),
      rec("opencode", "passed", T1),
      rec("agy", "passed", T1),
    ]);
    const res = gate();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^OK$/m);
    expect(res.stdout).toContain("r_CLAUDEPASSED");
  });

  it("a skipped record for a harness that is not installed is ignored and does not fail the gate", () => {
    writeFileSync(statusFile, JSON.stringify(statusAll({ agy: false })));
    writeRecords([...passAll(T1).slice(0, 2), rec("agy", "skipped", T2)]);
    const res = gate();
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("agy");
    expect(res.stdout).toMatch(/^OK$/m);
  });

  it("a passed record at an old version followed by no record at the pin exits 1 with the version pin line", () => {
    writeRecords([rec("claude", "passed", T1, { version: "2.1.200" }), rec("opencode", "passed", T1), rec("agy", "passed", T1)]);
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("GATE claude no passed record at version pin 2.1.304");
    expect(res.stdout).toMatch(/^FAIL: 1 problem\(s\)$/m);
  });

  it("a passed record followed by a later failed record exits 1", () => {
    writeRecords([...passAll(T1), rec("claude", "failed", T2)]);
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^GATE claude /m);
  });

  it("a later record is judged by ts, not by array position", () => {
    // The failed record is written later in the array but is older by ts.
    writeRecords([rec("claude", "passed", T2), rec("claude", "failed", T1), rec("opencode", "passed", T1), rec("agy", "passed", T1)]);
    const res = gate();
    expect(res.status).toBe(0);
  });

  it("a harness that is not installed and has no records does not fail the gate", () => {
    writeFileSync(statusFile, JSON.stringify(statusAll({ opencode: false, agy: false })));
    writeRecords([rec("claude", "passed", T1)]);
    const res = gate();
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("opencode");
    expect(res.stdout).not.toContain("agy");
    expect(res.stdout).toMatch(/^OK$/m);
  });

  it("a malformed record file exits 2", () => {
    writeRecords("[{\"harness\": ");
    const res = gate();
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/live-smoke\.json/);
  });

  it("a record file that is not an array exits 2", () => {
    writeRecords({ harness: "claude" });
    const res = gate();
    expect(res.status).toBe(2);
  });

  it("a missing record file is treated as no records", () => {
    const res = gate();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^FAIL: 3 problem\(s\)$/m);
  });

  it("the gate does not create the record file or its directory", () => {
    gate();
    expect(existsSync(recordFile)).toBe(false);
    expect(existsSync(path.join(root, ".substrate"))).toBe(false);
  });

  it("the gate does not modify an existing record file", () => {
    writeRecords(passAll());
    const before = readFileSync(recordFile, "utf8");
    gate();
    expect(readFileSync(recordFile, "utf8")).toBe(before);
  });
});
