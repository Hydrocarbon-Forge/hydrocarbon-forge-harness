import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configCommand, isKnownSettingsKey } from "../../../src/cli/commands/config.js";
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

  it("get exits 2 with the key and a hint for an unknown key (text mode)", async () => {
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
    expect(exitCode).toBe(2);
    expect(stdout.getOutput()).toBe("");
    expect(stderr.getOutput()).toContain("Error: unknown settings key: no.such.key\n");
    expect(stderr.getOutput()).toContain("Hint: run substrate config list");
  });

  it("get prints one error object line for an unknown key (json mode)", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: { outputFormat: "json" },
      rawArgs: ["get", "no.such.key"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toBe("");
    const out = stdout.getOutput();
    expect(out.endsWith("\n") && out.indexOf("\n") === out.length - 1).toBe(true);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toContain("unknown settings key: no.such.key");
  });

  it("get prints a string value quoted as JSON in json mode, and raw in text mode", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".substrate"), { recursive: true });
    writeFileSync(join(cwd, ".substrate", "settings.json"), JSON.stringify({ backends: { claude: { bin: "claude" } } }));
    const jsonOut = createMockWritable();
    const jsonCode = await configCommand.execute({
      cwd,
      flags: { outputFormat: "json" },
      rawArgs: ["get", "backends.claude.bin"],
      stdout: jsonOut,
      stderr: createMockWritable(),
    });
    expect(jsonCode).toBe(0);
    expect(jsonOut.getOutput()).toBe('"claude"\n');
    expect(JSON.parse(jsonOut.getOutput())).toBe("claude");

    const textOut = createMockWritable();
    const textCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["get", "backends.claude.bin"],
      stdout: textOut,
      stderr: createMockWritable(),
    });
    expect(textCode).toBe(0);
    expect(textOut.getOutput()).toBe("claude\n");
  });

  it("get and list print one json error object on stdout for an invalid settings file (json mode)", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".substrate"), { recursive: true });
    writeFileSync(join(cwd, ".substrate", "settings.json"), "{ not valid json");
    for (const rawArgs of [["get", "concurrency.workers"], ["list"]]) {
      const stdout = createMockWritable();
      const stderr = createMockWritable();
      const exitCode = await configCommand.execute({
        cwd,
        flags: { outputFormat: "json" },
        rawArgs,
        stdout,
        stderr,
      });
      expect(exitCode, rawArgs.join(" ")).toBe(2);
      expect(stderr.getOutput(), rawArgs.join(" ")).toBe("");
      const out = stdout.getOutput();
      expect(out.indexOf("\n"), rawArgs.join(" ")).toBe(out.length - 1);
      const parsed = JSON.parse(out) as { error: string };
      expect(typeof parsed.error, rawArgs.join(" ")).toBe("string");
      expect(parsed.error.length, rawArgs.join(" ")).toBeGreaterThan(0);
    }
  });

  it("get prints null in json mode for a known key that is unset", async () => {
    const stdout = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd: tmp(),
      flags: { outputFormat: "json" },
      rawArgs: ["get", "backends.claude.bin"],
      stdout,
      stderr: createMockWritable(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.getOutput()).toBe("null\n");
  });

  it("get prints undefined and exits 0 for a known key that is unset", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["get", "backends.claude.bin"],
      stdout,
      stderr: createMockWritable(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.getOutput()).toBe("undefined\n");
  });

  it("get accepts wildcard map keys under pricing, routing and profiles", async () => {
    const cwd = tmp();
    for (const key of [
      "pricing.models.some-model.input_per_mtok",
      "profiles.anyprovider.plan.model",
      "routing.feature.model",
      "backends.opencode.extra.anything",
    ]) {
      const stdout = createMockWritable();
      const stderr = createMockWritable();
      const exitCode = await configCommand.execute({
        cwd,
        flags: {},
        rawArgs: ["get", key],
        stdout,
        stderr,
      });
      expect(exitCode, key).toBe(0);
      expect(stderr.getOutput(), key).toBe("");
    }
  });

  it("get rejects a key that goes below a leaf or names a missing branch", async () => {
    const cwd = tmp();
    for (const key of ["concurrency.workers.extra", "budgets.nope", "routing.feature.nope.model"]) {
      const stderr = createMockWritable();
      const exitCode = await configCommand.execute({
        cwd,
        flags: {},
        rawArgs: ["get", key],
        stdout: createMockWritable(),
        stderr,
      });
      expect(exitCode, key).toBe(2);
      expect(stderr.getOutput(), key).toContain(`unknown settings key: ${key}`);
    }
  });

  it("isKnownSettingsKey separates schema paths from unknown ones", () => {
    expect(isKnownSettingsKey("concurrency.workers")).toBe(true);
    expect(isKnownSettingsKey("execution.strategy")).toBe(true);
    // R6.7: keys removed from the schema are no longer schema paths.
    expect(isKnownSettingsKey("hooks.stop")).toBe(false);
    expect(isKnownSettingsKey("git.branch_prefix")).toBe(false);
    expect(isKnownSettingsKey("sandbox.network")).toBe(false);
    expect(isKnownSettingsKey("backends.claude.bin")).toBe(true);
    expect(isKnownSettingsKey("no.such.key")).toBe(false);
    expect(isKnownSettingsKey("constructor")).toBe(false);
    expect(isKnownSettingsKey("__proto__.x")).toBe(false);
  });

  it("list in json mode prints one compact line", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: { outputFormat: "json" },
      rawArgs: ["list"],
      stdout,
      stderr: createMockWritable(),
    });
    expect(exitCode).toBe(0);
    const out = stdout.getOutput();
    expect(out.indexOf("\n")).toBe(out.length - 1);
    expect(JSON.parse(out)).toHaveProperty("concurrency");
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

  it("set of a provider key without --local exits 2, names the key, hints --local and writes nothing", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".substrate"), { recursive: true });
    const settingsFile = join(cwd, ".substrate", "settings.json");
    writeFileSync(settingsFile, '{"defaults":{}}');
    const before = readFileSync(settingsFile);
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["set", "backends.opencode.provider.base_url", "http://example.invalid/v1"],
      stdout: createMockWritable(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toContain("Invalid setting backends.opencode.provider.base_url");
    expect(stderr.getOutput()).toContain("--local");
    expect(Buffer.compare(readFileSync(settingsFile), before)).toBe(0);
    await expect(loadSettings({ projectDir: cwd, userConfigDir: tmp() })).resolves.toBeDefined();
  });

  it("set of a provider key with --local writes settings.local.json and the loader accepts it", async () => {
    const cwd = tmp();
    const stdout = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: { local: true },
      rawArgs: ["set", "backends.opencode.provider.base_url", "http://example.invalid/v1"],
      stdout,
      stderr: createMockWritable(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(join(cwd, ".substrate", "settings.json"))).toBe(false);
    const settings = await loadSettings({ projectDir: cwd, userConfigDir: tmp() });
    expect(settings.backends.opencode.provider?.base_url).toBe("http://example.invalid/v1");
  });

  it("set of a defaults provider with no profile exits 2 and writes nothing", async () => {
    const cwd = tmp();
    const stderr = createMockWritable();
    const exitCode = await configCommand.execute({
      cwd,
      flags: {},
      rawArgs: ["set", "defaults.planner_provider", "nope"],
      stdout: createMockWritable(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.getOutput()).toContain("Invalid setting defaults.planner_provider");
    expect(stderr.getOutput()).not.toContain("--local");
    expect(existsSync(join(cwd, ".substrate"))).toBe(false);
  });
});
