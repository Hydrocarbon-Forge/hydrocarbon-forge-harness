import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve("scripts/check-settings.mjs");

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

describe("check-settings script", () => {
  it("exits 0 with OK on clean tree", () => {
    const root = path.resolve("test/fixtures/check/clean");
    const res = run(["--root", root]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  it("exits 1 and prints expected RULE lines on bad tree", () => {
    const root = path.resolve("test/fixtures/check/settings-bad");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^unread-settings-key\s+src\/contracts\/index\.ts:1/m);
    expect(res.stdout).toMatch(/^FAIL:\s+\d+\s+violation\(s\)$/m);
  });

  it("fails with stale allowlist entry message", () => {
    const root = path.resolve("test/fixtures/check/stale-allowlist");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("Stale allowlist entry");
    expect(res.stdout).toMatch(/^FAIL:\s+\d+\s+violation\(s\)$/m);
  });

  it("fails when an entry's until WP has status DONE", () => {
    const root = path.resolve("test/fixtures/check/done-wp");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("Debt of finished WP R0.1 still present");
    expect(res.stdout).toMatch(/^FAIL:\s+\d+\s+violation\(s\)$/m);
  });

  it("counts leaf reads through values taken from wildcard records, but still reports unread wildcard leaves", () => {
    const root = path.resolve("test/fixtures/check/settings-wildcard");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    // Read live as `rates.input_per_mtok` and `route.model`: not reported.
    expect(res.stdout).not.toContain("pricing.models.*.input_per_mtok");
    expect(res.stdout).not.toContain("routing.*.model");
    // Seeded true positives: never read.
    expect(res.stdout).toMatch(/^unread-settings-key\s+src\/contracts\/index\.ts:1 Settings key "pricing\.models\.\*\.unused_rate"/m);
    expect(res.stdout).toMatch(/^unread-settings-key\s+src\/contracts\/index\.ts:1 Settings key "routing\.\*\.bogus_field"/m);
    expect(res.stdout).toMatch(/^FAIL:\s+2\s+violation\(s\)$/m);
  });
});
