import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Engine merges fall back to a substrate identity only when git has none configured. These
// tests spawn the built CLI with empty global and system git config and no identity variables,
// then read the author of the merge commits the engine created.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");
const SCENARIO = { calls: [{ edits: { "feature.txt": "created\n" }, reply: "DONE" }] };
const IDENTITY_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

interface Scratch {
  root: string;
  project: string;
  globalConfig: string;
  systemConfig: string;
  shim: string;
  spawnLog: string;
}

function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-identity-"));
  const project = join(root, "project");
  const shim = join(root, "shim");
  const globalConfig = join(root, "global.gitconfig");
  const systemConfig = join(root, "system.gitconfig");
  const spawnLog = join(root, "spawns.log");
  mkdirSync(project);
  mkdirSync(shim);
  writeFileSync(globalConfig, "", "utf8");
  writeFileSync(systemConfig, "", "utf8");
  for (const name of ["claude", "opencode", "agy"]) {
    const file = join(shim, name);
    writeFileSync(file, `#!/bin/sh\necho "${name}" >> "${spawnLog}"\nexec "${join(FAKE_BIN, name)}" "$@"\n`, "utf8");
    chmodSync(file, 0o755);
  }
  return { root, project, globalConfig, systemConfig, shim, spawnLog };
}

// Seeds a repository without any identity configured. The seed commit gets its author from
// the environment of this one command, not from git config.
function seedRepo(s: Scratch): void {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: s.globalConfig, GIT_CONFIG_SYSTEM: s.systemConfig };
  for (const v of IDENTITY_VARS) delete env[v];
  const git = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execFileSync("git", args, { cwd: s.project, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-b", "main"]);
  writeFileSync(join(s.project, "README.md"), "seed\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-m", "seed"], {
    GIT_AUTHOR_NAME: "Seed Person",
    GIT_AUTHOR_EMAIL: "seed@example.com",
    GIT_COMMITTER_NAME: "Seed Person",
    GIT_COMMITTER_EMAIL: "seed@example.com",
  });
}

function runCli(s: Scratch, args: string[]) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const v of IDENTITY_VARS) delete env[v];
  env.GIT_CONFIG_GLOBAL = s.globalConfig;
  env.GIT_CONFIG_SYSTEM = s.systemConfig;
  env.HOME = s.root;
  env.SUBSTRATE_CONFIG_DIR = join(s.root, "config");
  env.PATH = `${s.shim}:${FAKE_BIN}:${process.env.PATH ?? ""}`;
  const scenarioFile = join(s.root, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify(SCENARIO), "utf8");
  env.FAKE_SCENARIO_FILE = scenarioFile;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: s.project, encoding: "utf8", env, timeout: 120000 });
}

// "name|email" of every merge commit in the repository.
function mergeAuthors(s: Scratch): string[] {
  const out = execFileSync("git", ["log", "--all", "--merges", "--format=%an|%ae"], {
    cwd: s.project,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: s.globalConfig, GIT_CONFIG_SYSTEM: s.systemConfig },
  });
  return out.split("\n").filter(Boolean);
}

describe("engine merges: git identity fallback", () => {
  let scratch: Scratch[] = [];
  const fresh = (): Scratch => {
    const s = makeScratch();
    scratch.push(s);
    return s;
  };

  beforeAll(() => {
    execFileSync("npm", ["run", "bundle"], { cwd: ROOT, stdio: "pipe" });
  }, 600000);

  afterAll(() => {
    for (const s of scratch) rmSync(s.root, { recursive: true, force: true });
    scratch = [];
  });

  it("with no identity configured or in the environment, the merge completes and is authored by the substrate fallback", () => {
    const s = fresh();
    seedRepo(s);
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "--verify", "test -f feature.txt", "create feature.txt"]);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).not.toContain("Committer identity unknown");
    expect(mergeAuthors(s)).toContain("substrate|substrate@localhost");
    // Nothing was written to the config files.
    expect(readFileSync(s.globalConfig, "utf8")).toBe("");
    expect(readFileSync(s.systemConfig, "utf8")).toBe("");
  });

  it("a configured identity wins: the merge is authored by the configured name and email", () => {
    const s = fresh();
    writeFileSync(s.globalConfig, "[user]\n\tname = Configured Person\n\temail = configured@example.com\n", "utf8");
    seedRepo(s);
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "--verify", "test -f feature.txt", "create feature.txt"]);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const authors = mergeAuthors(s);
    expect(authors).toContain("Configured Person|configured@example.com");
    expect(authors).not.toContain("substrate|substrate@localhost");
  });
});
