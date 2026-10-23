import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configCommand, type CommandContext } from "../../../src/cli/commands/config.js";
import { loadSettings } from "../../../src/config/index.js";

// `config unset` removes a key from the project or local settings file (owner, 2026-10-23), and a settings file that
// still carries the removed budget keys loads without error.

function sink(): { write: (s: string) => boolean; text: () => string } {
  let buf = "";
  return {
    write: (s: string) => {
      buf += s;
      return true;
    },
    text: () => buf,
  };
}

function ctxFor(cwd: string, rawArgs: string[], flags: Record<string, unknown> = {}) {
  const stdout = sink();
  const stderr = sink();
  const ctx = {
    cwd,
    flags,
    rawArgs,
    stdout,
    stderr,
  } as unknown as CommandContext;
  return { ctx, stdout, stderr };
}

describe("config unset", () => {
  let cwd: string;
  let userDir: string;
  const savedEnv = process.env.SUBSTRATE_CONFIG_DIR;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "substrate-unset-"));
    userDir = mkdtempSync(join(tmpdir(), "substrate-unset-user-"));
    process.env.SUBSTRATE_CONFIG_DIR = userDir;
    mkdirSync(join(cwd, ".substrate"), { recursive: true });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SUBSTRATE_CONFIG_DIR;
    else process.env.SUBSTRATE_CONFIG_DIR = savedEnv;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  const projectFile = () => join(cwd, ".substrate", "settings.json");
  const localFile = () => join(cwd, ".substrate", "settings.local.json");

  it("removes one key from the project file, keeps the other keys, and prunes an emptied parent", async () => {
    writeFileSync(
      projectFile(),
      JSON.stringify({ concurrency: { workers: 9 }, budgets: { planner_format_retries: 4 } }),
    );
    const { ctx, stdout } = ctxFor(cwd, ["unset", "budgets.planner_format_retries"]);
    expect(await configCommand.execute(ctx)).toBe(0);
    expect(stdout.text()).toContain("Unset budgets.planner_format_retries");
    const file = JSON.parse(readFileSync(projectFile(), "utf8"));
    expect(file).toEqual({ concurrency: { workers: 9 } });
  });

  it("exits 0 and says so when the key is not set in the file", async () => {
    writeFileSync(projectFile(), JSON.stringify({ concurrency: { workers: 9 } }));
    const { ctx, stdout } = ctxFor(cwd, ["unset", "sandbox.enabled"]);
    expect(await configCommand.execute(ctx)).toBe(0);
    expect(stdout.text()).toContain("not set in the project settings file");
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({ concurrency: { workers: 9 } });
  });

  it("exits 0 when there is no settings file at all", async () => {
    const { ctx, stdout } = ctxFor(cwd, ["unset", "concurrency.workers"]);
    expect(await configCommand.execute(ctx)).toBe(0);
    expect(stdout.text()).toContain("not set");
    expect(existsSync(projectFile())).toBe(false);
  });

  it("exits 2 for a key that is not in the settings schema, and writes nothing", async () => {
    writeFileSync(projectFile(), JSON.stringify({ concurrency: { workers: 9 } }));
    const { ctx, stderr } = ctxFor(cwd, ["unset", "concurrency.nope"]);
    expect(await configCommand.execute(ctx)).toBe(2);
    expect(stderr.text()).toContain("unknown settings key");
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({ concurrency: { workers: 9 } });
  });

  it("with --local removes the key from settings.local.json and leaves settings.json alone", async () => {
    writeFileSync(projectFile(), JSON.stringify({ concurrency: { workers: 2 } }));
    writeFileSync(localFile(), JSON.stringify({ concurrency: { workers: 7 } }));
    const { ctx } = ctxFor(cwd, ["unset", "concurrency.workers"], { local: true });
    expect(await configCommand.execute(ctx)).toBe(0);
    expect(JSON.parse(readFileSync(localFile(), "utf8"))).toEqual({});
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({ concurrency: { workers: 2 } });
  });

  it("removes an old budget key from a settings file that still carries it", async () => {
    writeFileSync(
      projectFile(),
      JSON.stringify({ budgets: { run: { max_usd: 5 }, task: { max_usd: 0.5 }, planner_format_retries: 3 } }),
    );
    const { ctx } = ctxFor(cwd, ["unset", "budgets.run"]);
    expect(await configCommand.execute(ctx)).toBe(0);
    const file = JSON.parse(readFileSync(projectFile(), "utf8"));
    expect(file.budgets).not.toHaveProperty("run");
    expect(file.budgets.planner_format_retries).toBe(3);
  });
});

describe("a settings file with the removed budget keys", () => {
  let cwd: string;
  let userDir: string;
  const savedEnv = process.env.SUBSTRATE_CONFIG_DIR;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "substrate-stale-"));
    userDir = mkdtempSync(join(tmpdir(), "substrate-stale-user-"));
    process.env.SUBSTRATE_CONFIG_DIR = userDir;
    mkdirSync(join(cwd, ".substrate"), { recursive: true });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SUBSTRATE_CONFIG_DIR;
    else process.env.SUBSTRATE_CONFIG_DIR = savedEnv;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("loads: the run, task and approval keys are dropped, the retry counts are kept", async () => {
    writeFileSync(
      join(cwd, ".substrate", "settings.json"),
      JSON.stringify({
        budgets: {
          run: { max_usd: 5 },
          task: { max_usd: 0.5, timeout_min: 30 },
          approval_threshold_usd: 2,
          planner_format_retries: 3,
        },
      }),
    );
    const settings = await loadSettings({ projectDir: cwd });
    expect(settings.budgets.planner_format_retries).toBe(3);
    expect(settings.budgets).not.toHaveProperty("run");
    expect(settings.budgets).not.toHaveProperty("task");
    expect(settings.budgets).not.toHaveProperty("approval_threshold_usd");
  });
});
