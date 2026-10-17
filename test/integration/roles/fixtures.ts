import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

import type {
  BackendEvent,
  Capabilities,
  Command,
  EngineEvent,
  EnvReport,
  HarnessAdapter,
  Manifest,
  RunId,
  SessionHandle,
  SessionResult,
  SpawnRequest,
  TaskId,
  TaskSpecFrontmatter,
  UsageRecord,
  VerifyResult,
} from "../../../src/contracts/index.js";

export interface MockSessionConfig {
  result?: Partial<SessionResult>;
  events?: BackendEvent[];
  onSpawn?: (req: SpawnRequest) => void;
  onKill?: (reason: "budget" | "timeout" | "cancel") => void;
}

export interface MockAdapterOptions {
  capabilities?: Partial<Capabilities>;
  onSpawn?: (req: SpawnRequest) => void;
  nextSession?: (req: SpawnRequest, index: number) => MockSessionConfig;
  sessionConfigs?: MockSessionConfig[];
}

export function createMockAdapter(options: MockAdapterOptions = {}): HarnessAdapter & {
  spawnedRequests: SpawnRequest[];
  killCalls: Array<{ sessionId: string; reason: string }>;
} {
  const spawnedRequests: SpawnRequest[] = [];
  const killCalls: Array<{ sessionId: string; reason: string }> = [];

  const defaultCapabilities: Capabilities = {
    name: "fake",
    version_pin: "1.0.0",
    effort: true,
    structured_output: true,
    budget_flag: true,
    cost_reported: true,
    resume: true,
    permission_denial_signal: "event",
    sandbox_flag: true,
    native_subagents_headless: false,
    max_concurrency: 4,
    ...(options.capabilities ?? {}),
  };

  return {
    capabilities: defaultCapabilities,
    spawnedRequests,
    killCalls,

    async validateEnvironment(): Promise<EnvReport> {
      return {
        ok: true,
        version: "1.0.0",
        pin_matches: true,
        problems: [],
      };
    },

    spawn(req: SpawnRequest): SessionHandle {
      const callIndex = spawnedRequests.length;
      spawnedRequests.push(req);

      if (options.onSpawn) {
        options.onSpawn(req);
      }

      const config: MockSessionConfig =
        options.nextSession?.(req, callIndex) ??
        options.sessionConfigs?.[callIndex] ??
        {};

      if (config.onSpawn) {
        config.onSpawn(req);
      }

      const sessionId =
        req.session?.resume ??
        req.session?.id ??
        `mock-session-${callIndex + 1}`;

      const defaultUsage: UsageRecord = {
        backend: "fake",
        model: req.model,
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.001,
        cost_source: "computed",
        at: new Date().toISOString(),
      };

      const sessionResult: SessionResult = {
        ok: true,
        session_id: sessionId,
        final_text: "Session completed successfully.",
        usage: defaultUsage,
        exit_code: 0,
        denials: [],
        ...(config.result ?? {}),
      };

      async function* generateEvents(): AsyncIterable<BackendEvent> {
        const events = config.events ?? [
          { type: "session.started", session_id: sessionId },
          { type: "assistant.text", text: "Processing..." },
          { type: "usage", record: defaultUsage, cumulative: true },
          {
            type: "session.result",
            ok: sessionResult.ok,
            final_text: sessionResult.final_text,
            exit_code: sessionResult.exit_code,
            usage: sessionResult.usage,
          },
        ];
        for (const evt of events) {
          yield evt;
        }
      }

      return {
        pid: 1000 + callIndex,
        events: generateEvents(),
        async result(): Promise<SessionResult> {
          return sessionResult;
        },
        async kill(reason: "budget" | "timeout" | "cancel"): Promise<void> {
          killCalls.push({ sessionId, reason });
          if (config.onKill) {
            config.onKill(reason);
          }
        },
      };
    },
  };
}

export function createEventCollector(): {
  events: EngineEvent[];
  onEvent: (event: EngineEvent) => void;
  byType: (type: string) => EngineEvent[];
  first: (type: string) => EngineEvent | undefined;
} {
  const events: EngineEvent[] = [];
  return {
    events,
    onEvent(event: EngineEvent): void {
      events.push(event);
    },
    byType(type: string): EngineEvent[] {
      return events.filter((e) => e.type === type);
    },
    first(type: string): EngineEvent | undefined {
      return events.find((e) => e.type === type);
    },
  };
}

export function sampleValidManifest(runId: RunId = "r_234567ABCDEF"): Manifest {
  return {
    version: 1,
    run_id: runId,
    goal: "Build feature component",
    base_ref: "main",
    ecosystem: "node-ts",
    setup: [{ run: "echo setup", timeout_s: 30 }],
    contracts: {
      files: ["contracts/types.ts"],
      typecheck: [{ run: "echo typecheck contracts", timeout_s: 30 }],
    },
    integration_verify: [{ run: "echo verify all", timeout_s: 60 }],
    tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    budget: {
      max_usd: 5.0,
      max_tokens: 200000,
      max_wall_min: 30,
    },
  };
}

export function sampleValidManifestYaml(runId?: RunId, overrides: Record<string, unknown> = {}): string {
  const manifest = sampleValidManifest(runId);
  return YAML.stringify({ ...manifest, ...overrides });
}

export function sampleValidTaskSpecFrontmatter(overrides: Partial<TaskSpecFrontmatter> = {}): TaskSpecFrontmatter {
  return {
    id: "T1",
    title: "Feature Component 1",
    class: "feature",
    depends_on: [],
    read: ["contracts/types.ts"],
    write: ["src/feature.ts"],
    create: ["test/feature.test.ts"],
    protected: ["contracts/types.ts"],
    verify: [{ run: "echo verify task", timeout_s: 30 }],
    effort: "medium",
    ...overrides,
  };
}

export const REQUIRED_SPEC_HEADINGS: Record<string, string> = {
  Objective: "Implement task component with verified contracts.",
  Interface: "```ts\nexport declare function feature(arg: string): boolean;\n```",
  Behavior: "Executes feature logic accurately.",
  Invariants: "Engine manages commits and counters.",
  "Edge cases": "Gracefully handles empty or invalid inputs.",
  Guardrails: "Never commit directly to git or modify protected files.",
  "Out of scope": "Performance optimizations or external telemetry.",
};

export function sampleValidTaskSpecMarkdown(options: {
  frontmatter?: Record<string, unknown>;
  headings?: Record<string, string>;
} = {}): string {
  const fm = {
    ...sampleValidTaskSpecFrontmatter(),
    ...(options.frontmatter ?? {}),
  };
  const headings = {
    ...REQUIRED_SPEC_HEADINGS,
    ...(options.headings ?? {}),
  };
  const body = Object.entries(headings)
    .map(([title, content]) => `## ${title}\n\n${content}`)
    .join("\n\n");

  return `---\n${YAML.stringify(fm)}---\n\n${body}\n`;
}

export function sampleValidContractStub(): string {
  return [
    "// Contract stubs for Substrate feature",
    "export interface FeatureOptions {",
    "  name: string;",
    "  enabled: boolean;",
    "}",
    "export declare function runFeature(opts: FeatureOptions): Promise<boolean>;",
  ].join("\n");
}
