import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// R7.6: a request is validated before the project directory is touched. An invalid model
// id in an empty directory exits 2 and leaves the directory empty (no .git, no .substrate).
// The built CLI runs with the fake harness first on PATH; no real harness is started.

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SUBSTRATE_MJS = join(PROJECT_ROOT, "dist/substrate.mjs");
const FAKE_BIN = join(PROJECT_ROOT, "test/fixtures/fake-harness/bin");

function runCli(cwd: string, args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "substrate-r76-home-"));
  try {
    return spawnSync(process.execPath, [SUBSTRATE_MJS, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, HOME: home, PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("R7.6: invalid requests leave the directory untouched", () => {
  it("an unknown model id exits 2 and the empty directory stays empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-r76-empty-"));
    try {
      const res = runCli(dir, [
        "run", "--plan", "claude:claude-sonnet-5-5:xhigh", "--work", "claude:claude-bogus-9-9:medium",
        "--merge", "make a snake game",
      ]);
      expect(res.status, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(2);
      expect(res.stdout).toContain("invalid_request");
      expect(res.stdout).toContain("unknown model 'claude-bogus-9-9'");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the owner's command gets past validation in an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-r76-owner-"));
    try {
      const res = runCli(dir, [
        "run", "--plan", "claude:claude-sonnet-5-5:xhigh", "--work", "claude:claude-haiku-5-5:medium",
        "--merge", "x",
      ]);
      const text = `${res.stdout}\n${res.stderr}`;
      expect(text).not.toContain("invalid_request");
      expect(text).not.toContain("unknown model");
      // Validation passed, so the empty directory was initialised as a repository.
      expect(existsSync(join(dir, ".git"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
