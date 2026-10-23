import type { Effort } from "../contracts/index.js";

// The wire types of the web API additions (docs/design/web-ui.md, section 5, extended by the web UI v2 run).
// Types only. The routes in src/web/routes.ts, src/web/launch.ts, src/web/settings.ts, src/web/models.ts and
// src/observe/plan-view.ts produce these shapes; the browser client reads them. Times are ISO 8601 UTC strings.

/** One role's model route as a person sets it. A null field is unset: the CLI's own default applies. */
export interface RoleRoute {
  backend: string | null;
  model: string | null;
  effort: Effort | null;
}

/** GET /api/models: what the pickers offer. Built from the same catalog `substrate models` prints. */
export interface ModelOption {
  id: string;
  display: string | null;
  efforts: string[];
  /** False when the price table has no entry: the cost of a run on this model shows as unknown. */
  priced: boolean;
}
export interface ModelsApi {
  generated_at: string;
  providers: { provider: string; installed: boolean; problems: string[]; models: ModelOption[] }[];
}

/** GET /api/projects/:id/settings: the project's saved planner and worker routes (roles.planner, roles.worker). */
export interface ProjectSettingsApi {
  project_id: string;
  planner: RoleRoute;
  worker: RoleRoute;
  /** Which settings layer each role's values came from. */
  sources: { planner: "project" | "local" | "user" | "default" | "unset"; worker: "project" | "local" | "user" | "default" | "unset" };
}

/**
 * POST /api/projects/:id/settings. A field set to a value is written with the same code `substrate config set` uses;
 * a field set to null is removed as `substrate config unset` removes it; an absent field is left alone.
 */
export interface ProjectSettingsUpdate {
  scope: "project" | "local";
  planner?: Partial<RoleRoute>;
  worker?: Partial<RoleRoute>;
}

/** The additions to every item of GET /api/projects: counts that let a list show a project at a glance. */
export interface ProjectStats {
  runs_total: number;
  /** Count of runs per run status (running, planned, paused, finished, failed, stopped, interrupted, cancelled). */
  by_status: Record<string, number>;
  /** Runs that wait for a person: paused for answers, planned and awaiting approval, or failed and not yet resumed. */
  needs_attention: number;
  cost_usd: number | null;
  cost_source: "reported" | "computed" | "unknown";
  last_run: {
    ref: string;
    run_id: string;
    status: string;
    request: string;
    started_at: string;
    tasks_total: number;
    tasks_passed: number;
  } | null;
  /** Statuses of the newest runs, newest first, at most 12: the project's recent history as a strip. */
  recent: { status: string; started_at: string }[];
}

/** POST /api/runs: launch a run from the browser. The server builds the same request the CLI's `--request -` reads. */
export interface LaunchRequest {
  project: { id: string } | { create: { parent: string; name: string } };
  /** The goal text, not blank. */
  request: string;
  /** "auto" (default) or "solo". Ignored when review is true. */
  mode?: "auto" | "solo";
  /** True plans only: the run ends `planned` and waits for approval (resume). */
  review?: boolean;
  /** Overrides for this run only. An unset field falls back to the project's saved route. */
  planner?: Partial<RoleRoute>;
  worker?: Partial<RoleRoute>;
  max_budget_usd?: number;
}
export interface LaunchAccepted {
  ref: string;
  project_id: string;
  run_id: string;
  created_project: boolean;
}

/** POST /api/runs/:ref/resume body. `worker` names the worker for a planned run being approved. */
export interface ResumeRequest {
  answers?: Record<string, string>;
  worker?: Partial<RoleRoute>;
}

/** One task of GET /api/runs/:ref/plan. */
export interface PlanTaskApi {
  id: string;
  title: string;
  class: string;
  depends_on: string[];
  /** Longest dependency chain above this task; 0 for a task with no dependency. */
  layer: number;
  /** The reducer's task state, or null when the run has not started the task. */
  state: string | null;
  generation: number | null;
  attempt: number | null;
  write_count: number;
  create_count: number;
  verify_count: number;
  /** The spec's advisory budget.max_usd, or null. */
  est_usd: number | null;
  cost_usd: number;
}

/** Which model and effort actually ran, per role and model, from the run's sessions. */
export interface ModelUsedApi {
  role: "planner" | "planner_chat" | "worker" | "repair";
  backend: string;
  model: string;
  effort: string | null;
  sessions: number;
  task_ids: string[];
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_source: "reported" | "computed" | "unknown";
}

/** GET /api/runs/:ref/plan: the plan as a person previews it, merged with the run's task states. */
export interface PlanPreview {
  ref: string;
  has_plan: boolean;
  goal: string | null;
  tasks: PlanTaskApi[];
  /** Sum of the specs' advisory budget.max_usd, or null when no task has one. */
  estimate_usd: number | null;
  decisions_text: string | null;
  /** Open questions of a run paused for answers; the id is what ResumeRequest.answers is keyed by. */
  questions: { id: string; text: string }[];
  warnings: string[];
  models_used: ModelUsedApi[];
}
