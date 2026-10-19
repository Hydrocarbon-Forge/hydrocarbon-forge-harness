import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import {
  initCommand,
  type CommandContext,
  type ParsedCliFlags,
} from "../../../src/cli/commands/init.js";

const BIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "fake-harness",
  "bin"
);

function createMockStream(): NodeJS.WriteStream & { getOutput: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as any;
  stream.isTTY = false;
  stream.getOutput = () => output;
  return stream;
}

// Empty strings neutralize any inherited settings overrides, and an empty config
// dir isolates the user layer, so results are deterministic on any machine.
let configDir: string;
const savedEnv: Record<string, string | undefined> = {};

function isolateEnv(): void {
  configDir = mkdtempSync(join(tmpdir(), "substrate-init-config-"));
  for (const key of [
    "SUBSTRATE_CONFIG_DIR",
    "SUBSTRATE_SETTINGS",
    "SUBSTRATE_PROJECT_DIR",
    "SUBSTRATE_SETTINGS_CONTENT",
    "SUBSTRATE_MODEL",
    "SUBSTRATE_WORKER_MODEL",
  ]) {
    savedEnv[key] = process.env[key];
    process.env[key] = key === "SUBSTRATE_CONFIG_DIR" ? configDir : "";
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

let projectDir: string;

// The fake executables answer --version with their pinned version, so every
// provider passes validateEnvironment. An explicit settings file supplies the
// bins so the project settings.json stays free for init to write.
function fakeSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backends: {
      claude: { bin: join(BIN_DIR, "claude") },
      opencode: { bin: join(BIN_DIR, "opencode") },
      agy: { bin: join(BIN_DIR, "agy") },
      ...overrides,
    },
  };
}

function writeSettingsFile(content: Record<string, unknown>): string {
  const path = join(projectDir, "explicit-settings.json");
  writeFileSync(path, JSON.stringify(content), "utf8");
  return path;
}

async function runInit(flags: ParsedCliFlags): Promise<{ code: number; out: string; err: string }> {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const code = await initCommand.execute({
    cwd: projectDir,
    flags,
    rawArgs: [],
    stdout,
    stderr,
  });
  return { code, out: stdout.getOutput(), err: stderr.getOutput() };
}

function substrateDir(): string {
  return join(projectDir, ".substrate");
}

beforeEach(() => {
  isolateEnv();
  projectDir = mkdtempSync(join(tmpdir(), "substrate-init-"));
});

afterEach(() => {
  restoreEnv();
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("init", () => {
  it("creates the runtime directories, .gitignore, and the charter stub", async () => {
    const settingsPath = writeSettingsFile(fakeSettings());
    const result = await runInit({ settings: settingsPath });

    expect(result.code).toBe(0);
    for (const dir of ["runs", "worktrees", "state", "sessions", "ledger", "archive"]) {
      expect(existsSync(join(substrateDir(), dir))).toBe(true);
    }

    const gitignore = readFileSync(join(substrateDir(), ".gitignore"), "utf8");
    expect(gitignore.split("\n")).toEqual([
      "runs/",
      "worktrees/",
      "state/",
      "sessions/",
      "ledger/",
      "settings.local.json",
      "",
    ]);
    expect(gitignore).not.toMatch(/archive/);

    const charter = readFileSync(join(substrateDir(), "charter.md"), "utf8");
    expect(charter.startsWith("# Charter")).toBe(true);
    expect(charter).toMatch(/sent to the planner/);
    expect(charter).toMatch(/4 KB/);
    expect(result.out).toContain("wrote .substrate/.gitignore");
    expect(result.out).toContain("wrote .substrate/charter.md");
  });

  it("writes no settings.json and lists installed providers with no slot flags", async () => {
    const settingsPath = writeSettingsFile(fakeSettings());
    const result = await runInit({ settings: settingsPath });

    expect(result.code).toBe(0);
    expect(existsSync(join(substrateDir(), "settings.json"))).toBe(false);

    expect(result.out).toMatch(/^claude: installed \(2\.1\.301\)$/m);
    expect(result.out).toMatch(/^opencode: installed \(2\.0\.21\)$/m);
    expect(result.out).toMatch(/^agy: installed \(1\.4\.0\)$/m);
    expect(result.out).toMatch(/models: haiku, sonnet, opus, fable/);
    expect(result.out).toMatch(
      /substrate init --provider claude --plan <id> --work <id> --fast <id>/
    );
    expect(result.err).toBe("");
  });

  it("skips a provider whose validateEnvironment is not ok", async () => {
    const settingsPath = writeSettingsFile(
      fakeSettings({ agy: { bin: join(projectDir, "no-agy") } })
    );
    const result = await runInit({ settings: settingsPath });

    expect(result.code).toBe(0);
    expect(result.out).not.toContain("agy:");
    expect(result.out.match(/installed/g)?.length).toBe(2);
  });

  it("writes settings.json with only the keys that differ from defaults", async () => {
    const settingsPath = writeSettingsFile(fakeSettings());
    const result = await runInit({
      settings: settingsPath,
      provider: "claude",
      plan: "opus:max",
      work: "sonnet",
      fast: "haiku:low",
    });

    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(join(substrateDir(), "settings.json"), "utf8"));
    expect(Object.keys(written).sort()).toEqual(["defaults", "profiles"]);
    expect(written.profiles).toEqual({
      claude: {
        plan: { model: "opus", effort: "max" },
        work: { model: "sonnet" },
        fast: { model: "haiku", effort: "low" },
      },
    });
    expect(written.defaults).toEqual({
      planner_provider: "claude",
      worker_provider: "claude",
    });
    expect(written.pricing).toBeUndefined();
    expect(result.out).toContain("wrote .substrate/settings.json");
  });

  it("keeps an existing settings.json without --force and prints kept", async () => {
    mkdirSync(substrateDir(), { recursive: true });
    const existing = { pricing: { models: { opus: { input_per_mtok: 5, output_per_mtok: 25 } } } };
    writeFileSync(join(substrateDir(), "settings.json"), JSON.stringify(existing), "utf8");
    writeFileSync(join(substrateDir(), ".gitignore"), "runs/\n", "utf8");
    const settingsPath = writeSettingsFile(fakeSettings());

    const result = await runInit({ settings: settingsPath, provider: "claude", plan: "opus", work: "sonnet" });

    expect(result.code).toBe(0);
    expect(result.out).toContain("kept .substrate/settings.json");
    expect(result.out).toContain("kept .substrate/.gitignore");
    expect(JSON.parse(readFileSync(join(substrateDir(), "settings.json"), "utf8"))).toEqual(existing);
  });

  it("rewrites an existing settings.json with --force", async () => {
    mkdirSync(substrateDir(), { recursive: true });
    writeFileSync(
      join(substrateDir(), "settings.json"),
      JSON.stringify({ pricing: { models: { opus: { input_per_mtok: 5, output_per_mtok: 25 } } } }),
      "utf8"
    );
    const settingsPath = writeSettingsFile(fakeSettings());

    const result = await runInit({
      settings: settingsPath,
      provider: "claude",
      plan: "opus",
      work: "sonnet",
      force: true,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("wrote .substrate/settings.json");
    const written = JSON.parse(readFileSync(join(substrateDir(), "settings.json"), "utf8"));
    expect(Object.keys(written).sort()).toEqual(["defaults", "profiles"]);
    expect(written.pricing).toBeUndefined();
    expect(written.profiles.claude.plan.model).toBe("opus");
  });

  it("does not change .git/info/exclude, and still writes .gitignore outside a git repository", async () => {
    const settingsPath = writeSettingsFile(fakeSettings());
    mkdirSync(join(projectDir, ".git", "info"), { recursive: true });
    const excludePath = join(projectDir, ".git", "info", "exclude");
    writeFileSync(excludePath, "# git excludes\nbuild/\n", "utf8");

    const result = await runInit({ settings: settingsPath });
    expect(result.code).toBe(0);
    expect(readFileSync(excludePath, "utf8")).toBe("# git excludes\nbuild/\n");
    expect(existsSync(join(substrateDir(), ".gitignore"))).toBe(true);
  });

  it("keeps an existing charter.md and does not overwrite it with --force", async () => {
    mkdirSync(substrateDir(), { recursive: true });
    writeFileSync(join(substrateDir(), "charter.md"), "# Charter\n\nMine.\n", "utf8");
    const settingsPath = writeSettingsFile(fakeSettings());

    const result = await runInit({ settings: settingsPath, force: true });
    expect(result.code).toBe(0);
    expect(result.out).toContain("kept .substrate/charter.md");
    expect(readFileSync(join(substrateDir(), "charter.md"), "utf8")).toBe("# Charter\n\nMine.\n");
  });

  it("rejects a model the provider does not list", async () => {
    const settingsPath = writeSettingsFile(fakeSettings());
    const result = await runInit({
      settings: settingsPath,
      provider: "claude",
      plan: "not-a-model",
      work: "sonnet",
    });

    expect(result.code).toBe(2);
    const validIds = result.err.match(/valid ids: (.+)\n/)?.[1];
    expect(validIds).toContain("haiku");
    expect(result.err).toBe(
      `Error: model 'not-a-model' is not listed by claude; valid ids: ${validIds}\n`
    );
    expect(existsSync(join(substrateDir(), "settings.json"))).toBe(false);
  });

  it("rejects slot flags without --provider and without --work", async () => {
    const settingsPath = writeSettingsFile(fakeSettings());

    const noProvider = await runInit({ settings: settingsPath, plan: "opus", fast: "haiku" });
    expect(noProvider.code).toBe(2);
    expect(noProvider.err).toBe("Error: --provider is required with slot flags\n");

    const missingWork = await runInit({ settings: settingsPath, provider: "claude", plan: "opus" });
    expect(missingWork.code).toBe(2);
    expect(missingWork.err).toBe("Error: --plan and --work are required together\n");
  });

  it("rejects a provider that is not installed", async () => {
    const settingsPath = writeSettingsFile(
      fakeSettings({ agy: { bin: join(projectDir, "no-agy") } })
    );
    const result = await runInit({
      settings: settingsPath,
      provider: "agy",
      plan: "haiku",
      work: "haiku",
    });

    expect(result.code).toBe(2);
    expect(result.err).toBe("Error: provider agy is not installed\n");
  });

  it("rejects an effort outside the Effort enum with the list of valid values", async () => {
    const settingsPath = writeSettingsFile(fakeSettings());
    const result = await runInit({
      settings: settingsPath,
      provider: "claude",
      plan: "opus:ultra",
      work: "sonnet",
    });

    expect(result.code).toBe(2);
    expect(result.err).toBe(
      'Error: effort "ultra" is not valid; valid efforts: low, medium, high, xhigh, max\n'
    );
  });
});
