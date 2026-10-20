import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// R7.2: run and plan refuse to start without a named model, and a missing git repository
// never reaches the planner. These tests spawn the built CLI directly in scratch directories
// (the shared runSubstrate helper writes .substrate/ first, which these tests must not do).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "substrate.mjs");
const FAKE_BIN = join(ROOT, "test", "fixtures", "fake-harness", "bin");
const SCENARIO_CALLS = {
  calls: [{ edits: { "feature.txt": "created\n" }, reply: "DONE" }],
};

interface Scratch {
  root: string;
  project: string;
  home: string;
  shim: string;
  spawnLog: string;
}

// Each scratch tree has a shim directory in front of the fake harnesses. The shims append
// one line per spawn and then exec the fake, so a spawn count is observable without a real binary.
function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "substrate-r72-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const shim = join(root, "shim");
  const spawnLog = join(root, "spawns.log");
  mkdirSync(project);
  mkdirSync(home);
  mkdirSync(shim);
  for (const name of ["claude", "opencode", "agy"]) {
    const file = join(shim, name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${name}" >> "${spawnLog}"\nexec "${join(FAKE_BIN, name)}" "$@"\n`,
      "utf8"
    );
    chmodSync(file, 0o755);
  }
  return { root, project, home, shim, spawnLog };
}

function spawnCount(s: Scratch): number {
  return existsSync(s.spawnLog) ? readFileSync(s.spawnLog, "utf8").split("\n").filter(Boolean).length : 0;
}

function runCli(
  s: Scratch,
  args: string[],
  opts: { cwd?: string; stdin?: string; scenario?: unknown; home?: string; identity?: boolean } = {}
) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${s.shim}:${FAKE_BIN}:${process.env.PATH ?? ""}`,
    HOME: opts.home ?? s.home,
    SUBSTRATE_CONFIG_DIR: join(s.root, "config"),
  };
  if (opts.identity) {
    // The engine's own merges need a committer identity; this stands in for the owner's git config.
    env.GIT_AUTHOR_NAME = "R72 Test";
    env.GIT_AUTHOR_EMAIL = "r72@example.com";
    env.GIT_COMMITTER_NAME = "R72 Test";
    env.GIT_COMMITTER_EMAIL = "r72@example.com";
  }
  delete env.SUBSTRATE_SETTINGS;
  if (opts.scenario !== undefined) {
    const scenarioFile = join(s.root, `scenario-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(scenarioFile, JSON.stringify(opts.scenario), "utf8");
    env.FAKE_SCENARIO_FILE = scenarioFile;
  } else {
    delete env.FAKE_SCENARIO_FILE;
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? s.project,
    input: opts.stdin ?? "",
    encoding: "utf8",
    env,
    timeout: 120000,
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("R7.2: run and plan need a named model and a git repository", () => {
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

  it("(1) run with no model flags exits 2, names both roles, creates no .substrate and spawns nothing", () => {
    const s = fresh();
    const res = runCli(s, ["run", "make a snake game"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("planner");
    expect(res.stderr).toContain("worker");
    expect(res.stderr).toContain("--plan claude:sonnet --work claude:haiku");
    expect(existsSync(join(s.project, ".substrate"))).toBe(false);
    expect(spawnCount(s)).toBe(0);
  });

  it("(2a) run with only --plan exits 2 and names the worker", () => {
    const s = fresh();
    const res = runCli(s, ["run", "--plan", "claude:claude-sonnet-5-5", "make a snake game"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("worker model");
    expect(res.stderr).not.toContain("planner model");
    expect(existsSync(join(s.project, ".substrate"))).toBe(false);
    expect(spawnCount(s)).toBe(0);
  });

  it("(2b) run with only --work exits 2 and names the planner", () => {
    const s = fresh();
    const res = runCli(s, ["run", "--work", "claude:haiku", "make a snake game"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("planner model");
    expect(res.stderr).not.toContain("worker model");
    expect(existsSync(join(s.project, ".substrate"))).toBe(false);
    expect(spawnCount(s)).toBe(0);
  });

  it("(3a) explicit solo with --work only runs and the worker's file lands on the run branch", () => {
    const s = fresh();
    git(s.project, ["init", "-b", "main"]);
    git(s.project, ["config", "user.name", "R72 Test"]);
    git(s.project, ["config", "user.email", "r72@example.com"]);
    git(s.project, ["commit", "--allow-empty", "-m", "seed"]);
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "--verify", "test -f feature.txt", "create feature.txt"], {
      scenario: SCENARIO_CALLS,
      identity: true,
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const branch = /Branch:\s+(\S+)/.exec(res.stdout)?.[1];
    expect(branch).toBeDefined();
    expect(git(s.project, ["show", `${branch}:feature.txt`])).toBe("created");
  });

  it("(3b) plan-only with --plan alone starts the planner", () => {
    const s = fresh();
    git(s.project, ["init", "-b", "main"]);
    git(s.project, ["config", "user.name", "R72 Test"]);
    git(s.project, ["config", "user.email", "r72@example.com"]);
    git(s.project, ["commit", "--allow-empty", "-m", "seed"]);
    const res = runCli(s, ["plan", "--plan", "claude:claude-sonnet-5-5", "rename the config key"], {
      scenario: { calls: [{ reply: "I cannot plan this\nNEEDS INPUT" }] },
    });
    expect(res.stderr).not.toContain("needs an explicit");
    expect(res.status).not.toBe(2);
    expect(spawnCount(s)).toBeGreaterThan(0);
  });

  it("(4) settings roles without command-line flags still exit 2 and spawn nothing", () => {
    const s = fresh();
    mkdirSync(join(s.project, ".substrate"));
    writeFileSync(
      join(s.project, ".substrate", "settings.json"),
      JSON.stringify({
        roles: {
          planner: { backend: "claude", model: "claude-sonnet-5-5" },
          worker: { backend: "claude", model: "haiku" },
        },
      }),
      "utf8"
    );
    const res = runCli(s, ["run", "make a snake game"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("needs an explicit");
    expect(existsSync(join(s.project, ".substrate", "runs"))).toBe(false);
    expect(spawnCount(s)).toBe(0);
  });

  it("(5) a non-empty directory that is not a repository exits 2 with no raw git text, no .substrate, no spawn", () => {
    const s = fresh();
    writeFileSync(join(s.project, "notes.txt"), "keep me\n", "utf8");
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "make a snake game"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("not a git repository: run git init (and commit) first, or run substrate in an empty directory");
    expect(`${res.stdout}${res.stderr}`).not.toContain("fatal");
    expect(existsSync(join(s.project, ".substrate"))).toBe(false);
    expect(spawnCount(s)).toBe(0);
  });

  it("(6) an empty non-repository directory is initialised with one empty commit and the run completes", () => {
    const s = fresh();
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "--verify", "test -f feature.txt", "create feature.txt"], {
      scenario: SCENARIO_CALLS,
      identity: true,
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("initialised a new git repository (empty directory)");
    expect(git(s.project, ["rev-list", "--max-parents=0", "--count", "HEAD"])).toBe("1");
    expect(git(s.project, ["log", "--format=%s", "--max-count=1", "--reverse", "HEAD"])).toBe("substrate: initial empty commit");
    const branch = /Branch:\s+(\S+)/.exec(res.stdout)?.[1];
    expect(branch).toBeDefined();
    expect(git(s.project, ["show", `${branch}:feature.txt`])).toBe("created");
  });

  it("(7) a fresh git init with no commits and an empty tree gets the initial commit and the run completes", () => {
    const s = fresh();
    git(s.project, ["init", "-b", "main"]);
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "--verify", "test -f feature.txt", "create feature.txt"], {
      scenario: SCENARIO_CALLS,
      identity: true,
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(git(s.project, ["log", "--format=%s", "HEAD"])).toBe("substrate: initial empty commit");
  });

  it("(7b) a repository with no commits that holds files exits 2 and names the missing commit", () => {
    const s = fresh();
    git(s.project, ["init", "-b", "main"]);
    writeFileSync(join(s.project, "notes.txt"), "keep me\n", "utf8");
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "make a snake game"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("no commits");
    expect(`${res.stdout}${res.stderr}`).not.toContain("fatal");
    expect(spawnCount(s)).toBe(0);
  });

  it("(8) json output: the refusal is one {\"error\":...} line on stdout with exit 2", () => {
    const s = fresh();
    const res = runCli(s, ["run", "--output-format", "json", "make a snake game"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout.trim());
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toContain("planner");
    expect(parsed.error).toContain("worker");
    expect(res.stdout.trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(s.project, ".substrate"))).toBe(false);
  });

  it("(9) the home directory is never initialised as a repository", () => {
    const s = fresh();
    const res = runCli(s, ["run", "--mode", "solo", "--work", "claude:haiku", "make a snake game"], {
      cwd: s.home,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("home directory");
    expect(existsSync(join(s.home, ".git"))).toBe(false);
    expect(readdirSync(s.home)).toHaveLength(0);
  });
});
