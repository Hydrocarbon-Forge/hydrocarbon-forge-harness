import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import type { ParsedPlan, ParsedTaskSpec } from "../../../src/spec/index.js";
import type { EngineState } from "../../../src/engine/reducer.js";
import type { EscalationAction } from "../../../src/engine/ladder.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import {
  createMockAdapter,
  createEventCollector,
  sampleValidManifestYaml,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../roles/fixtures.js";

export interface BuildFailurePacketOptions {
  runId: Contracts.RunId;
  taskId: Contracts.TaskId;
  generation: number;
  failureClass: Contracts.FailureClass;
  specPath: string;
  attempts: Contracts.WorkerReport[];
  worktreePath: string;
  baseRef: string;
  packetDir: string;
  verifyOutput?: Contracts.VerifyResult[];
  scopeViolations?: string[];
  workerSummary?: string;
  relatedContracts?: string[];
  dependents?: Contracts.TaskId[];
  maxDiffBytes?: number;
}

export interface ReplanExecutionOptions {
  runId: Contracts.RunId;
  taskId: Contracts.TaskId;
  packet: Contracts.FailurePacket;
  state: EngineState;
  settings: Contracts.Settings;
  adapter: Contracts.HarnessAdapter;
  runDir: string;
  repoRoot: string;
  baseRef: string;
  decisionsLog?: string;
  onEvent?: (event: Contracts.EngineEvent) => void;
}

export interface ReplanResult {
  level: "L0" | "L1" | "L2" | "L3";
  status: "replan_ready" | "paused" | "healed";
  action: EscalationAction;
  revisedSpec?: ParsedTaskSpec;
  revisedPlan?: ParsedPlan;
  packet: Contracts.FailurePacket;
  diagnostics?: Contracts.Diagnostic[];
  pauseReason?: Contracts.PauseReason;
}

let buildFailurePacket: (opts: BuildFailurePacketOptions) => Promise<Contracts.FailurePacket>;
let executeReplan: (opts: ReplanExecutionOptions) => Promise<ReplanResult>;
let resolveTaskRoute: (
  taskClass: string,
  generation: number,
  settings: Contracts.Settings,
) => Contracts.Route;

beforeAll(async () => {
  const packetMod = (await import("../../../src/engine/packet.js" as any)) as any;
  buildFailurePacket = packetMod.buildFailurePacket;

  const replanMod = (await import("../../../src/engine/replan.js" as any)) as any;
  executeReplan = replanMod.executeReplan;
  const routerMod = (await import("../../../src/roles/router.js" as any)) as any;
  resolveTaskRoute = routerMod.resolveTaskRoute;
});

function makeRunId(): Contracts.RunId {
  return "r_234567ABCDEF";
}

function makeInitialEngineState(runId: Contracts.RunId, taskId: Contracts.TaskId = "T1"): EngineState {
  return {
    run_id: runId,
    state: "EXECUTING",
    tasks: {
      [taskId]: {
        id: taskId,
        state: "FAILED",
        generation: 1,
        attempt: 2,
        failure_class: "verify_failed",
      },
    },
    usage: { total_usd: 0.05, by_role: { worker: 0.05 } },
    checkpoints: [],
  };
}

function makeSampleWorkerReport(
  taskId: Contracts.TaskId = "T1",
  generation = 1,
  attempt = 1,
  overrides: Partial<Contracts.WorkerReport> = {},
): Contracts.WorkerReport {
  return {
    task_id: taskId,
    generation,
    attempt,
    session_id: `worker-sess-${generation}-${attempt}`,
    backend: "fake",
    model: "claude-haiku-5-5",
    status: "failed",
    failure_class: "verify_failed",
    files_changed: ["src/feature.ts"],
    usage: {
      backend: "fake",
      model: "claude-haiku-5-5",
      input_tokens: 150,
      output_tokens: 75,
      cost_usd: 0.002,
      cost_source: "computed",
      at: new Date().toISOString(),
    },
    duration_ms: 1200,
    verify: [
      {
        cmd: "npm test",
        exit_code: 1,
        timed_out: false,
        duration_ms: 300,
        stdout_tail: "Failing test output tail",
        stderr_tail: "",
        truncated: false,
      },
    ],
    denials: [],
    final_message: "Completed edits but tests failed with assertion error.",
    ...overrides,
  };
}

describe("Replan Loop and Failure Packets (src/engine/packet.ts & src/engine/replan.ts)", () => {
  let repo: TestRepo;
  let runDir: string;
  let packetDir: string;
  let worktreeDir: string;
  let specPath: string;

  beforeEach(() => {
    repo = createTestRepo("substrate-replan-test-");
    runDir = mkdtempSync(join(tmpdir(), "substrate-replan-rundir-"));
    packetDir = join(runDir, "packets");
    mkdirSync(packetDir, { recursive: true });

    worktreeDir = mkdtempSync(join(tmpdir(), "substrate-worktree-"));
    specPath = join(runDir, "T1.md");
    writeFileSync(specPath, sampleValidTaskSpecMarkdown(), "utf8");

    // Commit a baseline file in repo
    repo.commitFile("src/feature.ts", "export const original = 0;\n");
  });

  afterEach(() => {
    repo.cleanup();
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
    if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true, force: true });
  });

  describe("Failure Packet Builder (src/engine/packet.ts)", () => {
    it("assembles deterministic FailurePacket, persists patch and json, and sanitizes worker summary", async () => {
      const runId = makeRunId();

      // Modify a file in the repo to generate diff
      repo.commitFile("src/feature.ts", "export const changed = 1;\n");

      const attempts = [
        makeSampleWorkerReport("T1", 1, 1),
        makeSampleWorkerReport("T1", 1, 2, {
          final_message: "Untrusted worker message with \x00 null bytes and \r carriage returns.",
        }),
      ];

      const packet = await buildFailurePacket({
        runId,
        taskId: "T1",
        generation: 1,
        failureClass: "verify_failed",
        specPath,
        attempts,
        worktreePath: repo.dir,
        baseRef: "HEAD~1",
        packetDir,
        verifyOutput: attempts[1].verify,
        scopeViolations: [],
        workerSummary: attempts[1].final_message,
        relatedContracts: ["contracts/types.ts"],
        dependents: ["T2"],
      });

      // Validated against Zod schema
      expect(Contracts.FailurePacket.safeParse(packet).success).toBe(true);

      expect(packet.run_id).toBe(runId);
      expect(packet.task_id).toBe("T1");
      expect(packet.generation).toBe(1);
      expect(packet.failure_class).toBe("verify_failed");
      expect(packet.attempts.length).toBe(2);
      expect(packet.dependents).toEqual(["T2"]);
      expect(packet.related_contracts).toEqual(["contracts/types.ts"]);

      // Diff metadata and files
      expect(packet.diff.stat).toBeDefined();
      expect(existsSync(packet.diff.patch_path)).toBe(true);

      // Persisted JSON packet exists
      const jsonPath = join(packetDir, "T1-g1.json");
      expect(existsSync(jsonPath)).toBe(true);

      // Sanitization: worker summary <= 2048 chars, no control chars
      expect(packet.worker_summary).not.toContain("\x00");
      expect(packet.worker_summary.length).toBeLessThanOrEqual(2048);
    });

    it("truncates diff and flags truncated: true when diff exceeds maxDiffBytes", async () => {
      const runId = makeRunId();

      // Write large content to generate a big diff
      const largeContent = "console.log('line');\n".repeat(200);
      repo.commitFile("src/feature.ts", largeContent);

      const packet = await buildFailurePacket({
        runId,
        taskId: "T1",
        generation: 1,
        failureClass: "verify_failed",
        specPath,
        attempts: [makeSampleWorkerReport("T1", 1, 1)],
        worktreePath: repo.dir,
        baseRef: "HEAD~1",
        packetDir,
        maxDiffBytes: 100, // Small cap to force truncation
      });

      expect(packet.diff.truncated).toBe(true);
      const patchContent = readFileSync(packet.diff.patch_path, "utf8");
      expect(Buffer.byteLength(patchContent, "utf8")).toBeLessThanOrEqual(100);
    });
  });

  describe("Escalation Route Resolution (resolveTaskRoute)", () => {
    it("returns base route for generation 1 and escalates along chain for generation >= 2", () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        routing: {
          ...DEFAULT_SETTINGS.routing,
          feature: { backend: "claude", model: "claude-haiku-5-5", effort: "low" },
          escalation: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
        },
      } as Contracts.Settings;

      const gen1 = resolveTaskRoute("feature", 1, settings);
      expect(gen1.model).toBe("claude-haiku-5-5");

      const gen2 = resolveTaskRoute("feature", 2, settings);
      expect(gen2.model).toBe("claude-sonnet-5-5");

      const gen3 = resolveTaskRoute("feature", 3, settings);
      expect(gen3.model).toBe("claude-opus-5-5");
    });

    it("pins to highest tier when generation exceeds escalation chain length without index error", () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        routing: {
          ...DEFAULT_SETTINGS.routing,
          feature: { backend: "claude", model: "claude-haiku-5-5", effort: "low" },
          escalation: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
        },
      } as Contracts.Settings;

      const gen4 = resolveTaskRoute("feature", 4, settings);
      expect(gen4.model).toBe("claude-opus-5-5");

      const gen10 = resolveTaskRoute("feature", 10, settings);
      expect(gen10.model).toBe("claude-opus-5-5");
    });
  });

  describe("Replan Escalation Ladder (executeReplan)", () => {
    it("pauses run immediately on permission_denied without triggering replanning", async () => {
      const runId = makeRunId();
      const collector = createEventCollector();
      const state = makeInitialEngineState(runId, "T1");

      const packet: Contracts.FailurePacket = {
        run_id: runId,
        task_id: "T1",
        generation: 1,
        failure_class: "permission_denied",
        spec_path: specPath,
        attempts: [makeSampleWorkerReport("T1", 1, 1, { failure_class: "permission_denied" })],
        diff: { stat: "", patch_path: join(packetDir, "T1-g1.patch"), truncated: false },
        verify_output: [],
        scope_violations: [],
        worker_summary: "Access denied to restricted tool.",
        related_contracts: [],
        dependents: [],
      };

      const adapter = createMockAdapter();

      const result = await executeReplan({
        runId,
        taskId: "T1",
        packet,
        state,
        settings: DEFAULT_SETTINGS,
        adapter,
        runDir,
        repoRoot: repo.dir,
        baseRef: "main",
        onEvent: collector.onEvent,
      });

      expect(result.level).toBe("L3");
      expect(result.status).toBe("paused");
      expect(result.pauseReason).toBe("permission_denied");

      const pausedEvent = collector.first("run.paused");
      expect(pausedEvent).toBeDefined();

      // Invariant: no planner session spawned for permission denial
      expect(adapter.spawnedRequests.length).toBe(0);
    });

    it("pauses run immediately on rate_limited without triggering replanning", async () => {
      const runId = makeRunId();
      const collector = createEventCollector();
      const state = makeInitialEngineState(runId, "T1");

      const packet: Contracts.FailurePacket = {
        run_id: runId,
        task_id: "T1",
        generation: 1,
        failure_class: "rate_limited",
        spec_path: specPath,
        attempts: [makeSampleWorkerReport("T1", 1, 1, { failure_class: "rate_limited" })],
        diff: { stat: "", patch_path: join(packetDir, "T1-g1.patch"), truncated: false },
        verify_output: [],
        scope_violations: [],
        worker_summary: "Rate limit reached.",
        related_contracts: [],
        dependents: [],
      };

      const adapter = createMockAdapter();

      const result = await executeReplan({
        runId,
        taskId: "T1",
        packet,
        state,
        settings: DEFAULT_SETTINGS,
        adapter,
        runDir,
        repoRoot: repo.dir,
        baseRef: "main",
        onEvent: collector.onEvent,
      });

      expect(result.level).toBe("L3");
      expect(result.status).toBe("paused");
      expect(result.pauseReason).toBe("rate_limited");
      expect(adapter.spawnedRequests.length).toBe(0);
    });

    it("executes L1 spec replan: escalates tier, spawns planner, parses and lints revised spec", async () => {
      const runId = makeRunId();
      const collector = createEventCollector();
      const state = makeInitialEngineState(runId, "T1");

      const packet: Contracts.FailurePacket = {
        run_id: runId,
        task_id: "T1",
        generation: 1,
        failure_class: "verify_failed",
        spec_path: specPath,
        attempts: [makeSampleWorkerReport("T1", 1, 2)],
        diff: { stat: "1 file changed", patch_path: join(packetDir, "T1-g1.patch"), truncated: false },
        verify_output: [
          {
            cmd: "npm test",
            exit_code: 1,
            timed_out: false,
            duration_ms: 100,
            stdout_tail: "Assertion error",
            stderr_tail: "",
            truncated: false,
          },
        ],
        scope_violations: [],
        worker_summary: "Failed tests",
        related_contracts: ["contracts/types.ts"],
        dependents: [],
      };

      const revisedSpecMarkdown = sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T1",
          title: "Revised Task 1",
          class: "feature",
          verify: [{ run: "echo revised verify", timeout_s: 30 }],
        },
      });

      const adapter = createMockAdapter({
        nextSession: () => ({
          // R3.5 rule 4: an L1 output is accepted only when the finish line names this task.
          result: { final_text: "REVISED T1" },
          onSpawn: (req) => {
            // Planner writes revised task spec
            mkdirSync(join(req.cwd, "tasks"), { recursive: true });
            writeFileSync(join(req.cwd, "tasks", "T1.md"), revisedSpecMarkdown, "utf8");
          },
        }),
      });

      // The revised spec is linted in the context of the current plan (R3.5 rule 4), so the
      // plan and its contract stub have to be in the run directory.
      writeFileSync(join(runDir, "manifest.yaml"), sampleValidManifestYaml(runId), "utf8");
      mkdirSync(join(runDir, "contracts"), { recursive: true });
      writeFileSync(join(runDir, "contracts", "types.ts"), sampleValidContractStub(), "utf8");

      const result = await executeReplan({
        runId,
        taskId: "T1",
        packet,
        state,
        settings: DEFAULT_SETTINGS,
        adapter,
        runDir,
        repoRoot: repo.dir,
        baseRef: "main",
        onEvent: collector.onEvent,
      });

      expect(result.level).toBe("L1");
      expect(result.status).toBe("replan_ready");
      expect(result.revisedSpec).toBeDefined();
      expect(result.revisedSpec?.frontmatter.id).toBe("T1");

      // Verify replan lifecycle events
      const started = collector.first("replan.started");
      expect(started).toBeDefined();
      const finished = collector.first("replan.finished");
      expect(finished).toBeDefined();
    });

    it("escalates to L2 contract defect when L1 replans for task are exhausted (generation > l1_replans_per_task)", async () => {
      const runId = makeRunId();
      const collector = createEventCollector();
      // Generation 3 with l1_replans_per_task = 2 -> L1 exhausted -> L2
      const state: EngineState = {
        ...makeInitialEngineState(runId, "T1"),
        tasks: {
          T1: {
            id: "T1",
            state: "FAILED",
            generation: 3,
            attempt: 2,
            failure_class: "verify_failed",
          },
          T2: {
            id: "T2",
            state: "PENDING",
            generation: 1,
            attempt: 1,
          },
        },
      };

      const packet: Contracts.FailurePacket = {
        run_id: runId,
        task_id: "T1",
        generation: 3,
        failure_class: "verify_failed",
        spec_path: specPath,
        attempts: [makeSampleWorkerReport("T1", 3, 2)],
        diff: { stat: "", patch_path: join(packetDir, "T1-g3.patch"), truncated: false },
        verify_output: [],
        scope_violations: [],
        worker_summary: "Exhausted all L1 replans",
        related_contracts: ["contracts/types.ts"],
        dependents: ["T2"],
      };

      const adapter = createMockAdapter({
        nextSession: () => ({
          // R3.5 rule 6: the L2 output is accepted only with the AMENDED finish line.
          result: { final_text: "AMENDED" },
          onSpawn: (req) => {
            // Planner amends contracts and manifest
            mkdirSync(join(req.cwd, "contracts"), { recursive: true });
            mkdirSync(join(req.cwd, "tasks"), { recursive: true });
            writeFileSync(
              join(req.cwd, "manifest.yaml"),
              sampleValidManifestYaml(runId),
              "utf8",
            );
            writeFileSync(
              join(req.cwd, "contracts", "types.ts"),
              sampleValidContractStub(),
              "utf8",
            );
            writeFileSync(
              join(req.cwd, "tasks", "T1.md"),
              sampleValidTaskSpecMarkdown(),
              "utf8",
            );
          },
        }),
      });

      const result = await executeReplan({
        runId,
        taskId: "T1",
        packet,
        state,
        settings: {
          ...DEFAULT_SETTINGS,
          budgets: {
            ...DEFAULT_SETTINGS.budgets,
            l1_replans_per_task: 2,
            l2_per_run: 2,
          },
        },
        adapter,
        runDir,
        repoRoot: repo.dir,
        baseRef: "main",
        onEvent: collector.onEvent,
      });

      expect(result.level).toBe("L2");
      expect(result.status).toBe("replan_ready");
      expect(result.revisedPlan).toBeDefined();
    });

    it("escalates to L3 pause with needs_human when L2 count reaches l2_per_run cap", async () => {
      const runId = makeRunId();
      const collector = createEventCollector();
      // State already has l2_count = 2 (equal to cap l2_per_run = 2)
      const state: any = {
        ...makeInitialEngineState(runId, "T1"),
        l2_count: 2,
        tasks: {
          T1: {
            id: "T1",
            state: "FAILED",
            generation: 3,
            attempt: 2,
            failure_class: "verify_failed",
          },
        },
      };

      const packet: Contracts.FailurePacket = {
        run_id: runId,
        task_id: "T1",
        generation: 3,
        failure_class: "verify_failed",
        spec_path: specPath,
        attempts: [makeSampleWorkerReport("T1", 3, 2)],
        diff: { stat: "", patch_path: join(packetDir, "T1-g3.patch"), truncated: false },
        verify_output: [],
        scope_violations: [],
        worker_summary: "L2 budget exhausted",
        related_contracts: [],
        dependents: [],
      };

      const adapter = createMockAdapter();

      const result = await executeReplan({
        runId,
        taskId: "T1",
        packet,
        state,
        settings: {
          ...DEFAULT_SETTINGS,
          budgets: {
            ...DEFAULT_SETTINGS.budgets,
            l1_replans_per_task: 2,
            l2_per_run: 2,
          },
        },
        adapter,
        runDir,
        repoRoot: repo.dir,
        baseRef: "main",
        onEvent: collector.onEvent,
      });

      expect(result.level).toBe("L3");
      expect(result.status).toBe("paused");
      expect(result.pauseReason).toBe("needs_human");

      const pausedEvent = collector.first("run.paused");
      expect(pausedEvent).toBeDefined();
    });
  });
});
