import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SETTINGS, loadSettings } from "../../../src/config/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "substrate-precedence-"));
}

function writeSettingsFile(dir: string, rel: string, body: string): string {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
}

describe("settings precedence: each layer beats the one below it in one loadSettings call", () => {
  it("layer 1: with no files anywhere the result is DEFAULT_SETTINGS", async () => {
    const result = await loadSettings({ projectDir: tmp(), userConfigDir: tmp(), env: {} });
    expect(result.concurrency.workers).toBe(DEFAULT_SETTINGS.concurrency.workers);
  });

  it("layer 2: the user file beats defaults", async () => {
    const projectDir = tmp();
    const userConfigDir = tmp();
    writeSettingsFile(
      userConfigDir,
      "settings.json",
      JSON.stringify({ concurrency: { workers: 2 } }),
    );
    const result = await loadSettings({ projectDir, userConfigDir, env: {} });
    expect(result.concurrency.workers).toBe(2);
  });

  it("layer 3: the project file beats the user file and defaults", async () => {
    const projectDir = tmp();
    const userConfigDir = tmp();
    writeSettingsFile(
      userConfigDir,
      "settings.json",
      JSON.stringify({ concurrency: { workers: 2 } }),
    );
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({ concurrency: { workers: 4 } }),
    );
    const result = await loadSettings({ projectDir, userConfigDir, env: {} });
    expect(result.concurrency.workers).toBe(4);
  });

  it("layer 4: the project local file beats project, user, and defaults", async () => {
    const projectDir = tmp();
    const userConfigDir = tmp();
    writeSettingsFile(
      userConfigDir,
      "settings.json",
      JSON.stringify({ concurrency: { workers: 2 } }),
    );
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({ concurrency: { workers: 4 } }),
    );
    writeSettingsFile(
      projectDir,
      ".substrate/settings.local.json",
      JSON.stringify({ concurrency: { workers: 5 } }),
    );
    const result = await loadSettings({ projectDir, userConfigDir, env: {} });
    expect(result.concurrency.workers).toBe(5);
  });

  it("layer 5: the explicit settings file beats local, project, user, and defaults", async () => {
    const projectDir = tmp();
    const userConfigDir = tmp();
    writeSettingsFile(
      userConfigDir,
      "settings.json",
      JSON.stringify({ concurrency: { workers: 2 } }),
    );
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({ concurrency: { workers: 4 } }),
    );
    writeSettingsFile(
      projectDir,
      ".substrate/settings.local.json",
      JSON.stringify({ concurrency: { workers: 5 } }),
    );
    const cliFile = writeSettingsFile(
      tmp(),
      "cli.json",
      JSON.stringify({ concurrency: { workers: 6 } }),
    );
    const result = await loadSettings({
      projectDir,
      userConfigDir,
      settingsFile: cliFile,
      env: {},
    });
    expect(result.concurrency.workers).toBe(6);
  });

  it("layer 6: the environment layer beats the user file", async () => {
    const projectDir = tmp();
    const userConfigDir = tmp();
    writeSettingsFile(
      userConfigDir,
      "settings.json",
      JSON.stringify({ roles: { planner: { model: "file-model" } } }),
    );
    const result = await loadSettings({
      projectDir,
      userConfigDir,
      env: { SUBSTRATE_MODEL: "env-model" },
    });
    expect(result.roles.planner.model).toBe("env-model");
  });

  it("layer 7: flags beat the environment layer", async () => {
    const projectDir = tmp();
    const userConfigDir = tmp();
    writeSettingsFile(
      userConfigDir,
      "settings.json",
      JSON.stringify({ roles: { planner: { model: "file-model" } } }),
    );
    const result = await loadSettings({
      projectDir,
      userConfigDir,
      env: { SUBSTRATE_MODEL: "env-model" },
      flags: { roles: { planner: { backend: "claude", model: "flag-model" } } },
    });
    expect(result.roles.planner.model).toBe("flag-model");
  });
});
