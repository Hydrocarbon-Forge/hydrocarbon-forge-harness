import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve("scripts/check-purity.mjs");

function run(args: string[]) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      status: err.status,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
    };
  }
}

describe("check-purity script", () => {
  it("exits 0 with OK on clean tree", () => {
    const root = path.resolve("test/fixtures/check/clean");
    const res = run(["--root", root]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  it("exits 1 and prints expected RULE lines on bad tree", () => {
    const root = path.resolve("test/fixtures/check/purity-bad");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^P1\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P2\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P3\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P4\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P5\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P6\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P7\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P8\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^P9\s+src\/engine\/engine\.ts/m);
    expect(res.stdout).toMatch(/^FAIL:\s+\d+\s+violation\(s\)$/m);
  });

  it("fails with stale allowlist entry message", () => {
    const root = path.resolve("test/fixtures/check/stale-allowlist");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("Stale allowlist entry");
    expect(res.stdout).toMatch(/^FAIL:\s+\d+\s+violation\(s\)$/m);
  });

  it("rejects an until that names a work package (no progress file is read)", () => {
    const root = path.resolve("test/fixtures/check/done-wp");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("Invalid 'until' in allowlist entry");
    expect(res.stdout).toMatch(/^FAIL:\s+\d+\s+violation\(s\)$/m);
  });
});
