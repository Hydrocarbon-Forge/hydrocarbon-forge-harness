declare module "*/bench/types.js" {
  export type BenchmarkArm = "A" | "B" | "C" | "D";

  export interface BenchmarkTaskSpec {
    id: string;
    title: string;
    description?: string;
    task_class: import("../../../src/contracts/index.js").TaskClass;
    tags?: string[];
    repo_fixture: string;
    base_commit?: string;
    setup?: import("../../../src/contracts/index.js").Command[];
    verify: import("../../../src/contracts/index.js").Command[];
    budget: import("../../../src/contracts/index.js").Budget;
  }

  export interface ArmConfig {
    arm: BenchmarkArm;
    mode: "solo" | "plan";
    model: string;
    backend?: import("../../../src/contracts/index.js").BackendName;
    effort?: import("../../../src/contracts/index.js").Effort;
    routeOverrides?: Record<
      import("../../../src/contracts/index.js").TaskClass,
      {
        backend: import("../../../src/contracts/index.js").BackendName;
        model: string;
        effort?: import("../../../src/contracts/index.js").Effort;
      }
    >;
  }

  export interface BenchmarkAttemptResult {
    taskId: string;
    arm: BenchmarkArm;
    repetition: number;
    passed: boolean;
    firstPassVerified: boolean;
    costUsd: number;
    durationMs: number;
    verifyResults: import("../../../src/contracts/index.js").VerifyResult[];
    error?: string;
  }

  export interface BenchmarkArmSummary {
    arm: BenchmarkArm;
    totalAttempts: number;
    passedAttempts: number;
    passRate: number;
    firstPassVerifyRate: number;
    totalCostUsd: number;
    meanCostUsd: number;
    meanDurationMs: number;
  }

  export interface HypothesisStatus {
    id: "H1" | "H2" | "H3";
    supported: boolean;
    evidence: string;
    metrics: Record<string, number | string | boolean>;
  }

  export interface BenchmarkHypotheses {
    h1: HypothesisStatus;
    h2: HypothesisStatus;
    h3: HypothesisStatus;
  }

  export interface BenchmarkRunConfig {
    taskPaths?: string[];
    arms?: BenchmarkArm[];
    repetitions: number;
    budgetCapUsd?: number;
    topModel?: string;
    cheapModel?: string;
    localModel?: string;
    concurrency?: number;
    dryRun?: boolean;
  }

  export interface BenchmarkReport {
    timestamp: string;
    config: BenchmarkRunConfig;
    armSummaries: Record<BenchmarkArm, BenchmarkArmSummary>;
    taskResults: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>>;
    hypotheses: BenchmarkHypotheses;
  }
}

declare module "*/bench/tasks.js" {
  import type { BenchmarkTaskSpec } from "*/bench/types.js";
  export function loadBenchmarkTasks(
    taskDirOrGlobs: string[],
    cwd?: string
  ): Promise<BenchmarkTaskSpec[]>;
}

declare module "*/bench/arms.js" {
  import type { Settings } from "../../../src/contracts/index.js";
  import type { BenchmarkArm, BenchmarkRunConfig, ArmConfig } from "*/bench/types.js";
  export function resolveArmConfig(
    arm: BenchmarkArm,
    settings: Settings,
    config: BenchmarkRunConfig
  ): ArmConfig;
}

declare module "*/bench/runner.js" {
  import type { BenchmarkTaskSpec, ArmConfig, BenchmarkAttemptResult } from "*/bench/types.js";
  export function runBenchmarkAttempt(
    task: BenchmarkTaskSpec,
    armConfig: ArmConfig,
    repetition: number,
    cwd: string
  ): Promise<BenchmarkAttemptResult>;
}

declare module "*/bench/report.js" {
  import type {
    BenchmarkTaskSpec,
    BenchmarkArm,
    BenchmarkArmSummary,
    BenchmarkAttemptResult,
    BenchmarkHypotheses,
    BenchmarkReport,
  } from "*/bench/types.js";
  export function evaluateHypotheses(
    tasks: BenchmarkTaskSpec[],
    summaries: Record<BenchmarkArm, BenchmarkArmSummary>,
    results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>>
  ): BenchmarkHypotheses;

  export function formatBenchmarkReport(
    report: BenchmarkReport,
    format: "text" | "json" | "markdown"
  ): string;
}

declare module "*/bench/index.js" {
  import type { Settings } from "../../../src/contracts/index.js";
  import type {
    BenchmarkArm,
    BenchmarkTaskSpec,
    ArmConfig,
    BenchmarkAttemptResult,
    BenchmarkArmSummary,
    HypothesisStatus,
    BenchmarkHypotheses,
    BenchmarkRunConfig,
    BenchmarkReport,
  } from "*/bench/types.js";
  export * from "*/bench/types.js";
  export function loadBenchmarkTasks(
    taskDirOrGlobs: string[],
    cwd?: string
  ): Promise<BenchmarkTaskSpec[]>;
  export function resolveArmConfig(
    arm: BenchmarkArm,
    settings: Settings,
    config: BenchmarkRunConfig
  ): ArmConfig;
  export function runBenchmarkAttempt(
    task: BenchmarkTaskSpec,
    armConfig: ArmConfig,
    repetition: number,
    cwd: string
  ): Promise<BenchmarkAttemptResult>;
  export function evaluateHypotheses(
    tasks: BenchmarkTaskSpec[],
    summaries: Record<BenchmarkArm, BenchmarkArmSummary>,
    results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>>
  ): BenchmarkHypotheses;
  export function formatBenchmarkReport(
    report: BenchmarkReport,
    format: "text" | "json" | "markdown"
  ): string;
  export function runBenchmarkSuite(
    config: BenchmarkRunConfig,
    cwd?: string
  ): Promise<BenchmarkReport>;
}

declare module "*/src/cli/bench.js" {
  import type { CliCommand } from "../../../src/cli/registry.js";
  export const benchCommand: CliCommand;
}
