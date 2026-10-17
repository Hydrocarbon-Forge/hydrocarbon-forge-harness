import type {
  TaskClass,
  Command,
  Budget,
  BackendName,
  Effort,
  VerifyResult,
} from "../src/contracts/index.js";

export type BenchmarkArm = "A" | "B" | "C" | "D";

export interface BenchmarkTaskSpec {
  id: string;
  title: string;
  description?: string;
  task_class: TaskClass;
  tags?: string[];
  repo_fixture: string;
  base_commit?: string;
  setup?: Command[];
  verify: Command[];
  budget: Budget;
}

export interface ArmConfig {
  arm: BenchmarkArm;
  mode: "solo" | "plan";
  model: string;
  backend?: BackendName;
  effort?: Effort;
  routeOverrides?: Record<
    TaskClass,
    {
      backend: BackendName;
      model: string;
      effort?: Effort;
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
  verifyResults: VerifyResult[];
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
