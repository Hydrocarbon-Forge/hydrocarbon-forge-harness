import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSettings, readEnvLayer } from "../../../src/config/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "substrate-env-"));
}

function writeSettingsFile(dir: string, rel: string, body: string): string {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
}

describe("SUBSTRATE_CONFIG_DIR selects the user settings dir", () => {
  it("reads <dir>/settings.json when set", async () => {
    const customDir = tmp();
    writeSettingsFile(
      customDir,
      "settings.json",
      JSON.stringify({ concurrency: { workers: 9 } }),
    );
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      env: { SUBSTRATE_CONFIG_DIR: customDir },
    });
    expect(settings.concurrency.workers).toBe(9);
  });

  it("wins over options.userConfigDir", async () => {
    const optionDir = tmp();
    writeSettingsFile(
      optionDir,
      "settings.json",
      JSON.stringify({ concurrency: { workers: 10 } }),
    );
    const envDir = tmp();
    writeSettingsFile(envDir, "settings.json", JSON.stringify({ concurrency: { workers: 11 } }));
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: optionDir,
      env: { SUBSTRATE_CONFIG_DIR: envDir },
    });
    expect(settings.concurrency.workers).toBe(11);
  });
});

describe("SUBSTRATE_PROJECT_DIR selects the project dir", () => {
  it("reads <dir>/.substrate/settings.json when set", async () => {
    const envProjectDir = tmp();
    writeSettingsFile(
      envProjectDir,
      ".substrate/settings.json",
      JSON.stringify({ concurrency: { workers: 9 } }),
    );
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      env: { SUBSTRATE_PROJECT_DIR: envProjectDir },
    });
    expect(settings.concurrency.workers).toBe(9);
  });

  it("wins over options.projectDir", async () => {
    const optionDir = tmp();
    writeSettingsFile(
      optionDir,
      ".substrate/settings.json",
      JSON.stringify({ concurrency: { workers: 10 } }),
    );
    const envDir = tmp();
    writeSettingsFile(
      envDir,
      ".substrate/settings.json",
      JSON.stringify({ concurrency: { workers: 11 } }),
    );
    const settings = await loadSettings({
      projectDir: optionDir,
      userConfigDir: tmp(),
      env: { SUBSTRATE_PROJECT_DIR: envDir },
    });
    expect(settings.concurrency.workers).toBe(11);
  });
});

describe("SUBSTRATE_SETTINGS selects the explicit settings file", () => {
  it("applies the file named in the environment", async () => {
    const envFile = writeSettingsFile(
      tmp(),
      "env-settings.json",
      JSON.stringify({ concurrency: { workers: 99 } }),
    );
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      env: { SUBSTRATE_SETTINGS: envFile },
    });
    expect(settings.concurrency.workers).toBe(99);
  });

  it("loses to options.settingsFile (--settings)", async () => {
    const envFile = writeSettingsFile(
      tmp(),
      "env-settings.json",
      JSON.stringify({ concurrency: { workers: 99 } }),
    );
    const flagFile = writeSettingsFile(
      tmp(),
      "flag-settings.json",
      JSON.stringify({ concurrency: { workers: 42 } }),
    );
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      settingsFile: flagFile,
      env: { SUBSTRATE_SETTINGS: envFile },
    });
    expect(settings.concurrency.workers).toBe(42);
  });
});

describe("SUBSTRATE_MAX_BUDGET_USD sets budgets.run.max_usd", () => {
  it("applies a finite number", async () => {
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      env: { SUBSTRATE_MAX_BUDGET_USD: "12.5" },
    });
    expect(settings.budgets.run.max_usd).toBe(12.5);
  });

  it("rejects a non-numeric value", async () => {
    await expect(
      loadSettings({
        projectDir: tmp(),
        userConfigDir: tmp(),
        env: { SUBSTRATE_MAX_BUDGET_USD: "abc" },
      }),
    ).rejects.toThrow("SUBSTRATE_MAX_BUDGET_USD must be a number");
  });

  it("rejects Infinity", async () => {
    await expect(
      loadSettings({
        projectDir: tmp(),
        userConfigDir: tmp(),
        env: { SUBSTRATE_MAX_BUDGET_USD: "Infinity" },
      }),
    ).rejects.toThrow("SUBSTRATE_MAX_BUDGET_USD must be a number");
  });
});

describe("model env vars set the role models", () => {
  it("SUBSTRATE_MODEL sets roles.planner.model", async () => {
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      env: { SUBSTRATE_MODEL: "env-model" },
    });
    expect(settings.roles.planner.model).toBe("env-model");
  });

  it("SUBSTRATE_WORKER_MODEL sets roles.worker.model", async () => {
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      env: { SUBSTRATE_WORKER_MODEL: "env-worker-model" },
    });
    expect(settings.roles.worker?.model).toBe("env-worker-model");
  });
});

describe("SUBSTRATE_PERMISSION_MODE sets runDefaults.permissionMode", () => {
  it("accepts each documented value", () => {
    for (const mode of ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]) {
      expect(readEnvLayer({ SUBSTRATE_PERMISSION_MODE: mode }).runDefaults.permissionMode).toBe(
        mode,
      );
    }
  });

  it("rejects an unknown value, naming the variable", () => {
    expect(() => readEnvLayer({ SUBSTRATE_PERMISSION_MODE: "yolo" })).toThrow(
      "SUBSTRATE_PERMISSION_MODE",
    );
  });

  it("loadSettings rejects an unknown value", async () => {
    await expect(
      loadSettings({
        projectDir: tmp(),
        userConfigDir: tmp(),
        env: { SUBSTRATE_PERMISSION_MODE: "yolo" },
      }),
    ).rejects.toThrow();
  });
});

describe("SUBSTRATE_OUTPUT_FORMAT sets runDefaults.outputFormat", () => {
  it("accepts each documented value", () => {
    for (const format of ["text", "json", "stream-json"]) {
      expect(readEnvLayer({ SUBSTRATE_OUTPUT_FORMAT: format }).runDefaults.outputFormat).toBe(
        format,
      );
    }
  });

  it("ignores an unknown value instead of erroring", () => {
    expect(() => readEnvLayer({ SUBSTRATE_OUTPUT_FORMAT: "xml" })).not.toThrow();
    expect(readEnvLayer({ SUBSTRATE_OUTPUT_FORMAT: "xml" }).runDefaults.outputFormat).toBeUndefined();
  });
});

describe("empty strings are treated as unset", () => {
  it("SUBSTRATE_MODEL: empty does not set roles", () => {
    expect(readEnvLayer({ SUBSTRATE_MODEL: "" }).settings.roles).toBeUndefined();
  });

  it("SUBSTRATE_MAX_BUDGET_USD: empty does not throw or set budgets", () => {
    expect(() => readEnvLayer({ SUBSTRATE_MAX_BUDGET_USD: "" })).not.toThrow();
    expect(readEnvLayer({ SUBSTRATE_MAX_BUDGET_USD: "" }).settings.budgets).toBeUndefined();
  });
});

describe("SUBSTRATE_LIVE is never read by readEnvLayer or loadSettings", () => {
  it("readEnvLayer ignores SUBSTRATE_LIVE", () => {
    const { settings, runDefaults } = readEnvLayer({ SUBSTRATE_LIVE: "1" });
    expect(settings).toEqual({});
    expect(runDefaults).toEqual({});
  });

  it("loadSettings ignores SUBSTRATE_LIVE", async () => {
    const settings = await loadSettings({
      projectDir: tmp(),
      userConfigDir: tmp(),
      env: { SUBSTRATE_LIVE: "1" },
    });
    expect(settings).toBeDefined();
  });
});
