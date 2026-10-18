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

import { ClaudeAdapter } from "../../../src/backends/adapters/claude.js";
import { fileURLToPath } from "node:url";

export function fakeClaudeAdapter(calls: unknown[]): {
  adapter: ClaudeAdapter;
  cleanup(): void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "sub-claude-"));
  const scenarioJson = join(tmp, "scenario.json");
  writeFileSync(scenarioJson, JSON.stringify({ calls }), "utf8");
  const binPath = fileURLToPath(
    new URL("../../fixtures/fake-harness/bin/claude", import.meta.url)
  );
  const wrapperPath = join(tmp, "claude");
  const script = `#!/bin/sh\nexport FAKE_SCENARIO_FILE='${scenarioJson}'\nexec '${binPath}' "$@"\n`;
  writeFileSync(wrapperPath, script, { mode: 0o755 });
  const adapter = new ClaudeAdapter({ bin: wrapperPath });
  return {
    adapter,
    cleanup() {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function setupScenarioEnv(
  name: string,
  options: {
    customSettings?: Partial<Settings>;
    customAdapter?: HarnessAdapter;
    adapter?: HarnessAdapter;
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

  const adapter = options.adapter ?? options.customAdapter ?? new FakeAdapter();

  return {
    repoRoot,
    runDir: runsDir,
    settings,
    adapter,
    testRepo,
    async cleanup() {
      testRepo.cleanup();
    },
  };
}

export function readEventLog(runDir: string, runId: RunId): EngineEvent[] {
  const eventsPath = join(runDir, runId, "events.jsonl");
  if (!existsSync(eventsPath)) {
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
    const fullPath = join(runDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
}
