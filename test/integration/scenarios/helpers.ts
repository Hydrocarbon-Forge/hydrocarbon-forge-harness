import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { expect } from "vitest";

import type {
  RunId,
  TaskId,
  SessionId,
  BackendName,
  RoleName,
  TaskClass,
  PermissionMode,
  PauseReason,
  FailureClass,
  Command,
  Budget,
  Manifest,
  TaskSpecFrontmatter,
  VerifyResult,
  UsageRecord,
  WorkerReport,
  FailurePacket,
  Diagnostic,
  HarnessAdapter,
  Settings,
  Route,
  EngineEvent,
  RunOptions,
  RunSummary,
  Engine,
} from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import type {
  EngineState,
  RunState,
  TaskState,
  TaskRuntimeState,
} from "../../../src/engine/reducer.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import { FakeAdapter } from "../../conformance/fake-adapter.js";

export interface EngineOptions {
  settings?: Settings;
  adapter?: HarnessAdapter;
}

export type EngineActionType =
  | "route"
  | "plan"
  | "lint"
  | "setup"
  | "worker"
  | "heal"
  | "replan"
  | "merge"
  | "integration"
  | "gate"
  | "abort";

export interface EngineAction {
  type: EngineActionType;
  taskId?: TaskId;
  batch?: TaskId[];
  reason?: PauseReason | "budget" | "timeout" | "cancel";
}

export interface EffectContext {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  settings: Settings;
  adapter: HarnessAdapter;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
}

export interface ScenarioEnv {
  repoRoot: string;
  runDir: string;
  settings: Settings;
  adapter: HarnessAdapter;
  testRepo: TestRepo;
  cleanup(): Promise<void>;
}

export interface EngineModule {
  EngineImpl: new (opts?: EngineOptions) => Engine;
  createEngine: (opts?: EngineOptions) => Engine;
  engine: Engine;
}

export interface EffectsModule {
  nextActions: (state: EngineState, settings: Settings) => EngineAction[];
  executeAction: (
    action: EngineAction,
    ctx: EffectContext,
    state: EngineState
  ) => Promise<EngineEvent[]>;
  runEffectsLoop: (
    ctx: EffectContext,
    initialState: EngineState
  ) => Promise<EngineState>;
}

export async function loadEngine(): Promise<EngineModule> {
  return await import("../../../src/engine/engine.js" as any);
}

export async function loadEffects(): Promise<EffectsModule> {
  return await import("../../../src/engine/effects.js" as any);
}

export async function setupScenarioEnv(
  name: string,
  options: {
    customSettings?: Partial<Settings>;
    customAdapter?: HarnessAdapter;
  } = {}
): Promise<ScenarioEnv> {
  const testRepo = createTestRepo(`sub-scen-${name}-`);
  const repoRoot = testRepo.dir;

  const substrateDir = join(repoRoot, ".substrate");
  const stateDir = join(substrateDir, "state");
  const runsDir = join(substrateDir, "runs");
  const worktreesDir = join(substrateDir, "worktrees");

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...(options.customSettings ?? {}),
  };

  const adapter = options.customAdapter ?? new FakeAdapter();

  return {
    repoRoot,
    runDir: runsDir,
    settings,
    adapter,
    testRepo,
    async cleanup() {
      if (process.env.SUBSTRATE_GOLDEN === "record" || process.env.SUBSTRATE_GOLDEN === "compare") {
        if (existsSync(runsDir)) {
          const runDirs = readdirSync(runsDir);
          for (const rId of runDirs) {
            if (!recordedRuns.has(rId) && existsSync(join(runsDir, rId, "events.jsonl"))) {
              readEventLog(runsDir, rId as RunId);
            }
          }
        }
      }
      testRepo.cleanup();
    },
  };
}

const recordedRuns = new Set<string>();
const callCounts = new Map<string, number>();

function normalizeEventForGolden(evt: EngineEvent): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(evt));
  clone.ts = "<ts>";
  clone.run_id = "<run_id>";
  const str = JSON.stringify(clone)
    .replace(/r_[A-Za-z0-9]{12}/g, "<run_id>")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<uuid>")
    .replace(/ses_[A-Za-z0-9]+/g, "<session>")
    .replace(/fake-session-[a-z0-9]+/g, "<session>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<iso_timestamp>")
    .replace(/\b[0-9a-f]{40}\b/g, "<commit_sha>");
  return JSON.parse(str);
}

function handleGolden(events: EngineEvent[]): void {
  const mode = process.env.SUBSTRATE_GOLDEN;
  if (mode !== "record" && mode !== "compare") {
    return;
  }
  let testPath: string | undefined;
  try {
    testPath = expect.getState().testPath;
  } catch {
    return;
  }
  if (!testPath) {
    return;
  }
  const name = basename(testPath).replace(/\.test\.ts$/, "");
  const goldenDir = join(process.cwd(), "test", "fixtures", "golden");
  if (!existsSync(goldenDir)) {
    mkdirSync(goldenDir, { recursive: true });
  }
  const goldenFile = join(goldenDir, `${name}.jsonl`);

  const callIdx = callCounts.get(name) ?? 0;
  callCounts.set(name, callIdx + 1);

  const normalized = events.map(normalizeEventForGolden);
  const content =
    normalized.map((e) => JSON.stringify(e)).join("\n") +
    (normalized.length > 0 ? "\n" : "");

  if (mode === "record") {
    if (callIdx === 0) {
      writeFileSync(goldenFile, content, "utf8");
    } else {
      appendFileSync(goldenFile, content, "utf8");
    }
  } else if (mode === "compare") {
    if (!existsSync(goldenFile)) {
      throw new Error(`Golden file not found: ${goldenFile}`);
    }
    const raw = readFileSync(goldenFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const allExpected = lines.map((l) => JSON.parse(l));

    // Group calls by seq === 1
    const calls: any[][] = [];
    let currentCall: any[] = [];
    for (const evt of allExpected) {
      if (evt.seq === 1 && currentCall.length > 0) {
        calls.push(currentCall);
        currentCall = [];
      }
      currentCall.push(evt);
    }
    if (currentCall.length > 0) {
      calls.push(currentCall);
    }

    const expectedForCall = calls[callIdx] ?? [];
    expect(normalized).toEqual(expectedForCall);
  }
}

export function readEventLog(runDir: string, runId: RunId): EngineEvent[] {
  recordedRuns.add(runId);
  const eventsPath = join(runDir, runId, "events.jsonl");
  if (!existsSync(eventsPath)) {
    handleGolden([]);
    return [];
  }
  const raw = readFileSync(eventsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events: EngineEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore torn lines per spec edge cases
    }
  }
  handleGolden(events);
  return events;
}

export function writePlanFiles(
  repoRoot: string,
  runId: RunId,
  manifest: Manifest,
  taskSpecs: Record<string, string>,
  contractFiles: Record<string, string> = {}
): void {
  const runDir = join(repoRoot, ".substrate", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const manifestPath = join(runDir, "manifest.yaml");
  writeFileSync(manifestPath, YAML.stringify(manifest), "utf8");

  for (const [specRel, content] of Object.entries(taskSpecs)) {
    const fullSpecPath = join(runDir, specRel);
    mkdirSync(dirname(fullSpecPath), { recursive: true });
    writeFileSync(fullSpecPath, content, "utf8");
  }

  for (const [relPath, content] of Object.entries(contractFiles)) {
    const fullPath = join(repoRoot, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
}
