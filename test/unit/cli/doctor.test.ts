import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import {
  doctorCommand,
  type CommandContext,
  type ParsedCliFlags,
} from "../../../src/cli/commands/doctor.js";

const BIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "fake-harness",
  "bin"
);

// The real git binary, captured before PATH is replaced so the git check stays
// deterministic, and a PATH that contains only node and git so bwrap is absent.
function findBinary(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return name;
}

const GIT_BINARY = findBinary("git");

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

let projectDir: string;
let pathDir: string;
const savedEnv: Record<string, string | undefined> = {};

function isolateEnv(): void {
  for (const key of [
    "PATH",
    "SUBSTRATE_CONFIG_DIR",
    "SUBSTRATE_SETTINGS",
    "SUBSTRATE_PROJECT_DIR",
    "SUBSTRATE_SETTINGS_CONTENT",
    "SUBSTRATE_MODEL",
    "SUBSTRATE_WORKER_MODEL",
  ]) {
    savedEnv[key] = process.env[key];
  }

  pathDir = mkdtempSync(join(tmpdir(), "substrate-doctor-path-"));
  symlinkSync(process.execPath, join(pathDir, "node"));
  symlinkSync(GIT_BINARY, join(pathDir, "git"));
  process.env.PATH = pathDir;
  process.env.SUBSTRATE_CONFIG_DIR = "";
  for (const key of ["SUBSTRATE_SETTINGS", "SUBSTRATE_PROJECT_DIR", "SUBSTRATE_MODEL"]) {
    process.env[key] = "";
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

let settingsPath: string;

// The fake executables answer --version with their pinned version, so each
// provider passes validateEnvironment unless the test overrides a pin or a bin.
function writeSettings(content: Record<string, unknown>): string {
  settingsPath = join(projectDir, "explicit-settings.json");
  writeFileSync(settingsPath, JSON.stringify(content), "utf8");
  return settingsPath;
}

function baseSettings(overrides: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  const backends: Record<string, Record<string, unknown>> = {
    claude: { bin: join(BIN_DIR, "claude") },
    opencode: { bin: join(BIN_DIR, "opencode") },
    agy: { bin: join(BIN_DIR, "agy") },
  };
  for (const [name, value] of Object.entries(overrides)) {
    backends[name] = { ...backends[name], ...value };
  }
  return { backends };
}

async function runDoctor(flags: ParsedCliFlags): Promise<{ code: number; out: string; err: string }> {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const code = await doctorCommand.execute({
    cwd: projectDir,
    flags,
    rawArgs: [],
    stdout,
    stderr,
  });
  return { code, out: stdout.getOutput(), err: stderr.getOutput() };
}

interface Check {
  name: string;
  status: string;
  detail: string;
  fix?: string;
}

function checksFromText(output: string): Check[] {
  return output
    .split("\n")
    .filter((line) => /^\[(PASS|WARN|FAIL)\] /.test(line))
    .map((line) => {
      const [, status, name, detail] = line.match(
        /^\[(PASS|WARN|FAIL)\] ([^:]+): (.*)$/
      ) as RegExpMatchArray;
      return { name, status, detail };
    });
}

function jsonRun(flags: ParsedCliFlags): Promise<{ code: number; json: any; out: string }> {
  return runDoctor({ ...flags, outputFormat: "json" }).then((result) => ({
    code: result.code,
    json: JSON.parse(result.out),
    out: result.out,
  }));
}

beforeEach(() => {
  isolateEnv();
  projectDir = mkdtempSync(join(tmpdir(), "substrate-doctor-"));
  settingsPath = join(projectDir, "explicit-settings.json");
});

afterEach(() => {
  restoreEnv();
  rmSync(pathDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("doctor", () => {
  it("runs the checks in order and prints one line per check with a fix line", async () => {
    const flags = { settings: writeSettings(baseSettings()) };
    const result = await runDoctor(flags);
    const checks = checksFromText(result.out);

    expect(result.code).toBe(0);
    expect(checks.map((check) => check.name)).toEqual([
      "node",
      "git",
      "claude",
      "opencode",
      "agy",
      "settings",
      "profiles",
      "bwrap",
    ]);
    expect(checks.filter((check) => check.name !== "bwrap").every((check) => check.status === "PASS")).toBe(true);

    expect(result.out).toContain("[PASS] node:");
    expect(result.out).toContain("[PASS] git:");
    expect(result.out).toContain("[WARN] bwrap: not found");
    expect(result.out).toContain("  fix: install bubblewrap");
  });

  it("fails when a provider version differs from its pin, naming the pinned version", async () => {
    const flags = {
      settings: writeSettings(baseSettings({ claude: { version_pin: "2.1.999" } })),
    };
    const result = await runDoctor(flags);

    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^\[FAIL\] claude: 2\.1\.304 differs from pinned 2\.1\.999$/m);
    expect(result.out).toMatch(/^  fix: install claude 2\.1\.999 \(the pinned version\)/m);
  });

  it("warns for a provider that is not installed and not named by settings", async () => {
    const flags = {
      settings: writeSettings(baseSettings({ agy: { bin: join(projectDir, "no-agy") } })),
    };
    const result = await runDoctor(flags);

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^\[WARN\] agy: /m);
    expect(result.out).toMatch(/^  fix: install the agy CLI harness/m);
  });

  it("fails for a missing provider that a profile or default names", async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...baseSettings({ agy: { bin: join(projectDir, "no-agy") } }),
        profiles: {
          agy: { plan: { model: "haiku" }, work: { model: "haiku" } },
        },
        defaults: { planner_provider: "agy" },
      }),
      "utf8"
    );

    const result = await runDoctor({ settings: settingsPath });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^\[FAIL\] agy: /m);
    expect(result.out).toMatch(/remove profiles\.agy/m);
  });

  it("warns when a profile model is not in the provider's listModels answer", async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...baseSettings(),
        profiles: {
          claude: { plan: { model: "not-a-model" }, work: { model: "opus" } },
        },
      }),
      "utf8"
    );

    const result = await runDoctor({ settings: settingsPath });
    expect(result.code).toBe(0);
    const warn = result.out.match(/^\[WARN\] profiles\.claude: (.*)$/m);
    expect(warn).not.toBeNull();
    expect(warn![1]).toContain("not listed by claude");
    expect(result.out).toMatch(/^  fix: choose a model claude lists: haiku, sonnet, opus, fable/m);
  });

  it("fails when settings.json cannot be loaded", async () => {
    writeFileSync(join(projectDir, "explicit-settings.json"), '{ "profiles": "not an object" }', "utf8");
    const result = await runDoctor({ settings: join(projectDir, "explicit-settings.json") });

    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^\[FAIL\] settings: /m);
    expect(result.out).toMatch(/^  fix: fix settings\.json$/m);
  });

  it("keeps the R1.8 JSON shape and adds the checks as a list", async () => {
    const run = await jsonRun({ settings: writeSettings(baseSettings()) });

    expect(Object.keys(run.json)).toEqual(["node", "git", "bubblewrap", "adapters", "checks"]);
    expect(run.json.node).toEqual({ version: process.versions.node, ok: true });
    expect(run.json.git.ok).toBe(true);
    expect(run.json.bubblewrap.ok).toBe(false);
    expect(run.json.adapters.claude).toBe("2.1.304");
    expect(Array.isArray(run.json.checks)).toBe(true);
    expect(run.out.split("\n")).toHaveLength(2);

    for (const check of run.json.checks) {
      expect(typeof check.name).toBe("string");
      expect(["PASS", "WARN", "FAIL"]).toContain(check.status);
      expect(typeof check.detail).toBe("string");
    }

    const bwrap = run.json.checks[run.json.checks.length - 1];
    expect(bwrap.name).toBe("bwrap");
    expect(bwrap.status).toBe("WARN");
    expect(bwrap.fix).toContain("install bubblewrap");
  });

  it("exits 1 when any check fails and 0 otherwise", async () => {
    const clean = await jsonRun({ settings: writeSettings(baseSettings()) });
    expect(clean.code).toBe(0);
    expect(clean.json.checks.some((check: Check) => check.status === "FAIL")).toBe(false);

    const drifted = await jsonRun({
      settings: writeSettings(baseSettings({ claude: { version_pin: "2.1.999" } })),
    });
    expect(drifted.code).toBe(1);
    expect(drifted.json.checks.some((check: Check) => check.status === "FAIL")).toBe(true);
  });
});
