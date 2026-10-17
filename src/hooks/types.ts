import type {
  Manifest,
  RunId,
  RunSummary,
  TaskId,
  WorkerReport,
} from "../contracts/index.js";

export type HookEventName =
  | "PreRun"
  | "PostPlan"
  | "PreTask"
  | "PostTask"
  | "PreMerge"
  | "PostMerge"
  | "RunFinished"
  | "Notification";

export interface HookConfig {
  command: string;
  timeout_s?: number;
}

export interface HookPayloadBase {
  event: HookEventName;
  run_id: RunId;
  cwd: string;
  timestamp: string;
}

export type HookPayload =
  | (HookPayloadBase & { event: "PreRun"; goal: string; mode: string })
  | (HookPayloadBase & { event: "PostPlan"; manifest: Manifest })
  | (HookPayloadBase & { event: "PreTask"; task_id: TaskId })
  | (HookPayloadBase & { event: "PostTask"; task_id: TaskId; report: WorkerReport });

export type HookMergePayload =
  | (HookPayloadBase & { event: "PreMerge"; task_id?: TaskId; batch?: TaskId[] })
  | (HookPayloadBase & { event: "PostMerge"; task_id?: TaskId; batch?: TaskId[]; commit_sha?: string })
  | (HookPayloadBase & { event: "RunFinished"; summary: RunSummary })
  | (HookPayloadBase & { event: "Notification"; message: string; title?: string });

export interface HookResult {
  command: string;
  exit_code: number | null;
  blocked: boolean;
  stderr: string;
  stdout: string;
  timed_out: boolean;
  duration_ms: number;
}

