import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createE2ERepo } from "./repo.js";

export interface RunSubstrateOptions {
  repo?: ReturnType<typeof createE2ERepo>; // if supplied, reused instead of creating a new repo
  beforeRun?: (repo: ReturnType<typeof createE2ERepo>) => void; // invoked right before running the substrate process
  files?: Record<string, string>; // written into the temp repo, committed as "seed"
  scenario?: { calls: unknown[] }; // written to a file outside the repo; sets FAKE_SCENARIO_FILE
  args: string[]; // argv after dist/substrate.mjs
  env?: Record<string, string>; // merged last (wins)
  stdin?: string; // omitted means stdin is closed (empty)
  settings?: Record<string, unknown>; // merged into .substrate/settings.json
  timeoutMs?: number; // default 120000
}

export interface RunSubstrateResult {
  exitCode: number; // child status; 124 when killed by the timeout
  stdout: string;
  stderr: string;
  repoDir: string; // the temp repo (removed by cleanup)
  runDir: string | null; // newest .substrate/runs/<id>/ or null
  events: Array<{ v: number; seq: number; ts: string; run_id: string; type: string; data: unknown }>;
  cleanup(): void;
}

function isPlainObject(item: unknown): item is Record<string, unknown> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (isPlainObject(val) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Executes dist/substrate.mjs in a seeded temporary git repository against fake executables.
 *
 * @param options RunSubstrateOptions
 * @returns RunSubstrateResult
 */
export function runSubstrate(options: RunSubstrateOptions): RunSubstrateResult {
  const projectRoot = resolve(__dirname, "../../..");
  const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
  const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");

  const repo = options.repo ?? createE2ERepo(options.files ?? {});
  const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-"));
  const homeDir = mkdtempSync(join(tmpdir(), "substrate-home-"));

  let scenarioPath: string | undefined;
  if (options.scenario) {
    scenarioPath = join(scenarioDir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(options.scenario), "utf8");
  }

  const baseSettings: Record<string, unknown> = {
    backends: {
      claude: { bin: join(binDir, "claude") },
      opencode: { bin: join(binDir, "opencode") },
      agy: { bin: join(binDir, "agy") },
    },
    concurrency: {
      workers: 1,
    },
  };

  const finalSettings = options.settings
    ? deepMerge(baseSettings, options.settings)
    : baseSettings;

  const dotSubstrateDir = join(repo.dir, ".substrate");
  mkdirSync(dotSubstrateDir, { recursive: true });
  writeFileSync(
    join(dotSubstrateDir, "settings.json"),
    JSON.stringify(finalSettings, null, 2),
    "utf8"
  );

  const env: Record<string, string> = {
    ...process.env,
    HOME: homeDir,
  };

  if (scenarioPath) {
    env.FAKE_SCENARIO_FILE = scenarioPath;
  } else {
    delete env.FAKE_SCENARIO_FILE;
  }

  if (options.env) {
    Object.assign(env, options.env);
  }

  if (options.beforeRun) {
    options.beforeRun(repo);
  }

  const timeout = options.timeoutMs ?? 120000;
  const proc = spawnSync(process.execPath, [substrateMjs, ...options.args], {
    cwd: repo.dir,
    input: options.stdin ?? "",
    timeout,
    encoding: "utf8",
    env,
  });

  let exitCode: number;
  if (proc.status !== null) {
    exitCode = proc.status;
  } else if (proc.error && (proc.error as any).code === "ETIMEDOUT") {
    exitCode = 124;
  } else if (proc.signal === "SIGTERM" || proc.signal === "SIGKILL") {
    exitCode = 124;
  } else {
    exitCode = 1;
  }

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";

  const runsBase = join(repo.dir, ".substrate", "runs");
  let runDir: string | null = null;
  let events: Array<{ v: number; seq: number; ts: string; run_id: string; type: string; data: unknown }> = [];

  if (existsSync(runsBase)) {
    const entries = readdirSync(runsBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    if (entries.length > 0) {
      runDir = join(runsBase, entries[entries.length - 1]);
      const eventsFile = join(runDir, "events.jsonl");
      if (existsSync(eventsFile)) {
        const content = readFileSync(eventsFile, "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        events = lines.map((line, idx) => {
          try {
            return JSON.parse(line);
          } catch (err) {
            throw new Error(
              `Failed to parse events.jsonl at line ${idx + 1}: ${(err as Error).message}`
            );
          }
        });
      }
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    repoDir: repo.dir,
    runDir,
    events,
    cleanup() {
      repo.cleanup();
      try {
        rmSync(scenarioDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {}
    },
  };
}
