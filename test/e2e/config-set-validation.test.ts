import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// R6.10: `config set` validates the merged settings before it writes. A provider key
// is local-only: without --local the write is refused (exit 2, file unchanged), and with
// --local it is written and later commands still load the settings.
const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");

function cli(dir: string, home: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [substrateMjs, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, HOME: home, SUBSTRATE_PROJECT_DIR: dir, SUBSTRATE_CONFIG_DIR: join(home, "cfg") },
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

describe("config set through the built CLI", () => {
  it("refuses a provider key without --local, writes nothing, and later commands still run", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-set-"));
    const home = mkdtempSync(join(tmpdir(), "substrate-set-home-"));
    try {
      mkdirSync(join(dir, ".substrate"), { recursive: true });
      const file = join(dir, ".substrate", "settings.json");
      writeFileSync(file, '{"concurrency":{"workers":2}}');
      const before = readFileSync(file, "utf8");

      const refused = cli(dir, home, ["config", "set", "backends.opencode.provider.base_url", "http://example.invalid/v1"]);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("backends.opencode.provider.base_url");
      expect(refused.stderr).toContain("--local");
      expect(readFileSync(file, "utf8")).toBe(before);

      const later = cli(dir, home, ["config", "get", "concurrency.workers"]);
      expect(later.status).toBe(0);
      expect(later.stdout.trim()).toBe("2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes a provider key with --local, and later commands still load and read it", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-set-"));
    const home = mkdtempSync(join(tmpdir(), "substrate-set-home-"));
    try {
      const set = cli(dir, home, ["config", "set", "backends.opencode.provider.base_url", "http://example.invalid/v1", "--local"]);
      expect(set.status).toBe(0);
      expect(existsSync(join(dir, ".substrate", "settings.json"))).toBe(false);

      const get = cli(dir, home, ["config", "get", "backends.opencode.provider.base_url"]);
      expect(get.status).toBe(0);
      expect(get.stdout.trim()).toBe("http://example.invalid/v1");

      const list = cli(dir, home, ["config", "list"]);
      expect(list.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an ordinary valid key still sets with exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-set-"));
    const home = mkdtempSync(join(tmpdir(), "substrate-set-home-"));
    try {
      const set = cli(dir, home, ["config", "set", "concurrency.workers", "5"]);
      expect(set.status).toBe(0);
      const get = cli(dir, home, ["config", "get", "concurrency.workers"]);
      expect(get.stdout.trim()).toBe("5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
