import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configCommand } from "../../../src/cli/commands/config.js";
import { DEFAULT_SETTINGS, loadSettings } from "../../../src/config/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "substrate-cmd-"));
}

function createMockWritable(): NodeJS.WriteStream & { getOutput: () => string } {
  const chunks: string[] = [];
  return {
    write(t: string) {
      chunks.push(t);
      return true;
    },
    getOutput: () => chunks.join(""),
  } as unknown as NodeJS.WriteStream & { getOutput: () => string };
}

const scrubbedVars = [
  "SUBSTRATE_CONFIG_DIR",
  "SUBSTRATE_PROJECT_DIR",
  "SUBSTRATE_SETTINGS",
  "SUBSTRATE_MAX_BUDGET_USD",
  "SUBSTRATE_MODEL",
  "SUBSTRATE_WORKER_MODEL",
  "SUBSTRATE_PERMISSION_MODE",
  "SUBSTRATE_OUTPUT_FORMAT",
];

describe("config command", () => {
  const saved: Record<string, string | undefined> = {};
  let realHome: string | undefined;
  let fakeHome: string;

  beforeAll(() => {
    for (const v of scrubbedVars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    realHome = process.env.HOME;
    fakeHome = tmp();
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    for (const v of scrubbedVars) {
      if (saved[v] === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = saved[v];
      }
    }
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("get prints a default scalar from the merged settings", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["get", "concurrency.workers"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    expect(stdout.getOutput()).toBe(String(DEFAULT_SETTINGS.concurrency.workers) + "\n");
  });

  it("get prints an object as indented JSON", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["get", "budgets.run"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    const out = stdout.getOutput();
    expect(JSON.parse(out.slice(0, -1))).toEqual(DEFAULT_SETTINGS.budgets.run);
    expect(out).toContain("\n  ");
  });

  it("get prints undefined for an absent key", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["get", "no.such.key"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    expect(stdout.getOutput()).toBe("undefined\n");
  });

  it("list prints the merged settings as indented JSON", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["list"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.getOutput().trim());
    expect(parsed).toEqual(
      await loadSettings({
        projectDir: cwd,
        userConfigDir: join(fakeHome, ".config", "substrate"),
        env: {},
      }),
    );
    expect(parsed).toHaveProperty("concurrency");
    expect(parsed).toHaveProperty("budgets");
    expect(parsed).toHaveProperty("roles");
  });

  it("bare config (no subcommand) prints the same as list", async () => {
    const listCwd = tmp();
    const listOut = createMockWritable();
    await configCommand.execute({
      cwd: listCwd,
      flags: {},
      rawArgs: ["list"],
      stdout: listOut,
      stderr: createMockWritable(),
    });

    const bareCwd = tmp();
    const bareOut = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd: bareCwd,
      flags: {},
      rawArgs: [],
      stdout: bareOut,
      stderr: createMockWritable(),
    });
    expect(exitCode).toBe(0);
    expect(bareOut.getOutput()).toBe(listOut.getOutput());
  });

  it("set writes the value to .substrate/settings.json", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["set", "concurrency.workers", "7"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    expect(stdout.getOutput()).toBe("Set concurrency.workers = 7\n");
    const file = JSON.parse(
      readFileSync(join(cwd, ".substrate", "settings.json"), "utf8"),
    ) as Record<string, Record<string, number>>;
    expect(file["concurrency"]["workers"]).toBe(7);
  });

  it("set preserves other keys of the target file", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".substrate"), { recursive: true });
    writeFileSync(
      join(cwd, ".substrate", "settings.json"),
      JSON.stringify({
        concurrency: { workers: 9 },
        budgets: { run: { max_usd: 1 } },
      }),
    );
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["set", "sandbox.enabled", "true"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    const file = JSON.parse(
      readFileSync(join(cwd, ".substrate", "settings.json"), "utf8"),
    ) as Record<string, any>;
    expect(file["concurrency"]["workers"]).toBe(9);
    expect(file["budgets"]["run"]["max_usd"]).toBe(1);
    expect(file["sandbox"]["enabled"]).toBe(true);
  });

  it("set --local writes settings.local.json and leaves settings.json absent", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: { local: true },
      rawArgs: ["set", "concurrency.workers", "8"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    const localFile = JSON.parse(
      readFileSync(join(cwd, ".substrate", "settings.local.json"), "utf8"),
    ) as Record<string, Record<string, number>>;
    expect(localFile["concurrency"]["workers"]).toBe(8);
    expect(existsSync(join(cwd, ".substrate", "settings.json"))).toBe(false);
  });

  it("set with an invalid value exits 2 and leaves the file byte-identical", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".substrate"), { recursive: true });
    const settingsFile = join(cwd, ".substrate", "settings.json");
    writeFileSync(settingsFile, "{}");
    const before = readFileSync(settingsFile);
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["set", "concurrency.workers", "notanumber"],
      stdout: createMockWritable(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toMatch(/Invalid setting concurrency\.workers:/);
    expect(Buffer.compare(readFileSync(settingsFile), before)).toBe(0);
  });

  it("set with an invalid value and no file creates no .substrate directory", async () => {
    const cwd = tmp();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["set", "sandbox.enabled", "maybe"],
      stdout: createMockWritable(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toMatch(/Invalid setting sandbox\.enabled:/);
    expect(existsSync(join(cwd, ".substrate"))).toBe(false);
  });

  it("get reflects a prior set in the same project", async () => {
    const cwd = tmp();
    const setCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["set", "concurrency.workers", "7"],
      stdout: createMockWritable(),
      stderr: createMockWritable(),
    });
    expect(setCode).toBe(0);

    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const getCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["get", "concurrency.workers"],
      stdout,
      stderr,
    });
    expect(getCode).toBe(0);
    expect(stdout.getOutput()).toBe("7\n");
  });

  it("get exits 2 when an explicit settings file is missing", async () => {
    const cwd = tmp();
    const missing = join(tmp(), "no-such-settings.json");
    process.env.SUBSTRATE_SETTINGS = missing;
    try {
      const stderr = createMockWritable();
      const exitCode = await configCommand.execute({
        cwd,
        flags: {},
        rawArgs: ["get", "concurrency.workers"],
        stdout: createMockWritable(),
        stderr,
      });
      expect(exitCode).toBe(2);
      expect(stderr.getOutput()).toContain("Error: Settings file not found: ");
    } finally {
      delete process.env.SUBSTRATE_SETTINGS;
    }
  });

  it("get without a key prints usage and exits 2", async () => {
    const cwd = tmp();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["get"],
      stdout: createMockWritable(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toContain("Usage:");
  });
});
