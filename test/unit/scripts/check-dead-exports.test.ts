import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
// @ts-ignore
import * as deadMod from "../../../scripts/check-dead-exports.mjs";

const { analyzeDead } = deadMod as any;

const scriptPath = path.resolve("scripts/check-dead-exports.mjs");

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

describe("check-dead-exports script and analyzeDead", () => {
  it("chain fixture reports both A and B", () => {
    const root = path.resolve("test/fixtures/check/dead-exports/chain");
    const dead = analyzeDead({ root, entries: ["src/index.ts"] });

    expect(dead.length).toBe(2);
    expect(dead.some((d: any) => d.name === "A" && d.path === "src/a.ts")).toBe(true);
    expect(dead.some((d: any) => d.name === "B" && d.path === "src/b.ts")).toBe(true);

    const res = run(["--root", root, "--entries", "src/index.ts"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^dead-export src\/a\.ts:\d+ A/m);
    expect(res.stdout).toMatch(/^dead-export src\/b\.ts:\d+ B/m);
    expect(res.stdout).toMatch(/^FAIL: 2 violation\(s\)$/m);
  });

  it("unused-import fixture reports the imported symbol", () => {
    const root = path.resolve("test/fixtures/check/dead-exports/unused-import");
    const dead = analyzeDead({ root, entries: ["src/index.ts"] });

    expect(dead.length).toBe(1);
    expect(dead[0].name).toBe("unused");
    expect(dead[0].path).toBe("src/lib.ts");

    const res = run(["--root", root, "--entries", "src/index.ts"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^dead-export src\/lib\.ts:\d+ unused/m);
    expect(res.stdout).toMatch(/^FAIL: 1 violation\(s\)$/m);
  });

  it("fixture where function is called from a live entry reports nothing", () => {
    const root = path.resolve("test/fixtures/check/dead-exports/live-call");
    const dead = analyzeDead({ root, entries: ["src/index.ts"] });

    expect(dead).toEqual([]);

    const res = run(["--root", root, "--entries", "src/index.ts"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  it("default entries reach src/cli/main.ts so dynamically imported modules are live", () => {
    const root = path.resolve("test/fixtures/check/dead-exports/dynamic-entry");
    // No entries argument: exercises the default entry list (src/cli/main.ts).
    const dead = analyzeDead({ root });

    expect(dead.map((d: any) => d.name)).toEqual(["unusedHelper"]);

    const res = run(["--root", root]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^dead-export src\/cli\/signals\.ts:\d+ unusedHelper$/m);
    expect(res.stdout).not.toContain("installSignalHandlers");
  });

  it("typeof X type queries count as uses of the value X; plain type-only references do not", () => {
    const root = path.resolve("test/fixtures/check/dead-exports/typeof-query");
    const dead = analyzeDead({ root, entries: ["src/index.ts"] });
    const names = dead.map((d: any) => d.name).sort();

    expect(names).not.toContain("Kept");
    expect(names).toEqual(["TypeOnly", "Unused", "takesTypeOnly"]);
  });

  it("consumer script value references keep src exports alive; without the consumer they are dead", () => {
    const root = path.resolve("test/fixtures/check/dead-exports/consumer-root");
    const dead = analyzeDead({ root, entries: ["src/index.ts"] });
    expect(dead.map((d: any) => d.name)).toEqual(["Dead"]);

    const withoutConsumer = analyzeDead({ root, entries: ["src/index.ts"], consumers: [] });
    expect(withoutConsumer.map((d: any) => d.name).sort()).toEqual(["Dead", "Schema"]);

    const res = run(["--root", root, "--entries", "src/index.ts"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^dead-export src\/contracts\/index\.ts:\d+ Dead$/m);
    expect(res.stdout).toMatch(/^FAIL: 1 violation\(s\)$/m);
  });
});
