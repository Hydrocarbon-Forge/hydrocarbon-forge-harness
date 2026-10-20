import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve("scripts/check-events.mjs");

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

describe("check-events script", () => {
  it("exits 0 with OK on clean tree", () => {
    const root = path.resolve("test/fixtures/check/clean");
    const res = run(["--root", root]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  it("exits 1 and prints expected RULE lines on bad tree", () => {
    const root = path.resolve("test/fixtures/check/events-bad");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^consumed-not-emitted\s+src\/engine\/reducer\.ts:\d+/m);
    expect(res.stdout).toMatch(/^emitted-not-consumed\s+src\/engine\/effects\.ts:\d+/m);
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

  it("counts events emitted via onEvent?.() in src/roles, and still reports a consumed event with no emitter", () => {
    const root = path.resolve("test/fixtures/check/events-roles");
    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    // False positive removed: emitted from src/roles/worker.ts.
    expect(res.stdout).not.toContain("task.emitted.fromrole");
    // True positive kept: consumed in the reducer, emitted nowhere.
    expect(res.stdout).toMatch(/^consumed-not-emitted\s+src\/engine\/reducer\.ts:\d+ Event type "task\.never\.emitted"/m);
    expect(res.stdout).toMatch(/^FAIL:\s+1\s+violation\(s\)$/m);
  });
});
