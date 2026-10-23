// The JSON shapes the web UI's new endpoints and fields exchange (docs/design/web-ui.md section 5, extended by
// docs/design/web-ui-v2.md). Types only: the server tasks fill them, the client tasks read them. Provider and effort
// are plain strings here because the server validates them against the Settings enums before it writes anything.

/** One model and effort a role runs with. `effort` is null when the provider default applies. */
export interface ApiModelChoice {
  provider: string;
  model: string;
  effort: string | null;
}

/** A role's current choice for a project, with where it comes from. */
export interface ApiRoleChoice extends ApiModelChoice {
  /** profile: a `profiles.<provider>` slot named by `defaults`; roles: `roles.planner`; routing: `routing.feature`; builtin: the built-in route. */
  source: "profile" | "roles" | "routing" | "builtin";
}

// GET /api/models?project=<id>&refresh=1
export interface ApiModelEntry {
  id: string;
  display: string | null;
  efforts: string[];
  price_per_mtok: { input: number; output: number } | null;
}

export interface ApiProviderModels {
  provider: "claude" | "opencode" | "agy";
  installed: boolean;
  version: string | null;
  problems: string[];
  models: ApiModelEntry[];
}

export interface ApiModelCatalog {
  generated_at: string;
  cache: "fresh" | "cached";
  providers: ApiProviderModels[];
}

// GET /api/projects/:id/settings, and the answer of POST /api/projects/:id/settings
export interface ApiProjectSettings {
  project_id: string;
  planner: ApiRoleChoice;
  worker: ApiRoleChoice;
  /** git.auto_merge: merge a passing run into the checked-out branch. */
  auto_merge: boolean;
  /** concurrency.workers */
  workers: number;
  /** budgets.run.max_usd, null when no cap is set. */
  max_run_usd: number | null;
}

// POST /api/projects/:id/settings: only the keys present are written, through `substrate config set`.
export interface ApiProjectSettingsUpdate {
  planner?: ApiModelChoice;
  worker?: ApiModelChoice;
  auto_merge?: boolean;
  workers?: number;
  max_run_usd?: number;
}

// POST /api/runs. Exactly one of `project` and `new_project`.
export interface ApiStartRunRequest {
  /** An existing project: a project id or an absolute path of a directory. */
  project?: string;
  /** A project to create: `parent` is an absolute directory that exists; the project is `<parent>/<name>`. */
  new_project?: { name: string; parent: string };
  request: string;
  /** Default: the project's settings (ApiProjectSettings). */
  planner?: ApiModelChoice;
  worker?: ApiModelChoice;
  mode?: "auto" | "plan" | "solo";
  /** Plan only, then stop for review (`run --review`). The run is approved with POST /api/runs/:ref/resume. */
  review?: boolean;
  merge?: boolean;
  verify?: string[];
  max_usd?: number;
  concurrency?: number;
}

export interface ApiStartRunResponse {
  ref: string;
  run_id: string;
  project_id: string;
  project_path: string;
  created_project: boolean;
  review: boolean;
}

// POST /api/runs/:ref/resume
export interface ApiResumeRequest {
  /** Answers to QUESTIONS.md items, keyed by question id (Q1, Q2). */
  answers?: Record<string, string>;
  /** The worker to run a planned (reviewed) run with: `resume --work`. */
  worker?: ApiModelChoice;
  /** A higher run budget: `resume --max-budget-usd`. */
  max_usd?: number;
}

// The library: GET /api/projects (and the `project` events of GET /api/stream). The first five fields are the
// existing Project shape.
export interface ApiProjectRunDot {
  ref: string;
  run_id: string;
  status: string;
  live: boolean;
  started_at: string;
  cost_usd: number;
  /** The first line of the request, at most 80 characters. */
  request: string;
}

export interface ApiProjectCard {
  id: string;
  path: string;
  name: string;
  last_run_at: string | null;
  running_count: number;
  first_seen: string;
  last_seen: string;
  run_count: number;
  /** Run count by run status (running, planned, paused, finished, failed, stopped, interrupted, cancelled). */
  status_counts: Record<string, number>;
  /** Runs waiting for the person: status paused or planned. */
  needs_attention: number;
  /** Status of the newest run, null when the project has no run. */
  last_status: string | null;
  total_cost_usd: number;
  /** True when any run's cost is unknown (the total then undercounts). */
  cost_unknown: boolean;
  /** The newest runs, newest first, at most 16. */
  recent: ApiProjectRunDot[];
}

// RunDetail additions (GET /api/runs/:ref)
export interface ApiPlanTask {
  id: string;
  title: string;
  class: string;
  depends_on: string[];
  write: string[];
  create: string[];
  /** The task's verify commands, as written in its spec. */
  verify: string[];
  /** The task's budget cap in USD from its spec, null when it has none. */
  budget_usd: number | null;
  effort: string | null;
}

export interface ApiPlanPreview {
  goal: string | null;
  ecosystem: string | null;
  tasks: ApiPlanTask[];
  integration_verify: string[];
  /** The sum of the task budget caps that are set, null when none is set. A ceiling, not a forecast. */
  estimated_max_usd: number | null;
  /** Plan files that could not be read or parsed, in plain words. */
  warnings: string[];
}

export interface ApiQuestion {
  id: string;
  text: string;
  default: string | null;
}

export interface ApiModelUse {
  /** The usage role: planner, planner_chat, worker, repair, and any other role the usage record names. */
  role: string;
  provider: string;
  model: string;
  /** The effort the run recorded for this role, null when it did not record one. */
  effort: string | null;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_source: "reported" | "computed" | "unknown";
}

export interface ApiRunModels {
  requested: { planner: ApiModelChoice; worker: ApiModelChoice };
  /** What actually ran, one row per role, provider and model, in first-use order. */
  used: ApiModelUse[];
}

/** What the person may do with the run now, decided by the server from the run's state. */
export interface ApiRunControls {
  can_stop: boolean;
  can_resume: boolean;
  /** A planned run waiting for review: resume approves it. */
  awaiting_review: boolean;
  /** A run paused with questions: resume with answers continues it. */
  awaiting_answers: boolean;
  /** The CLI command that lands a finished, unmerged run, or null. */
  merge_command: string | null;
  /** The CLI command that resumes the run, or null. */
  resume_command: string | null;
}

export interface ApiRunDetailExtras {
  plan: ApiPlanPreview | null;
  questions: ApiQuestion[];
  models: ApiRunModels;
  controls: ApiRunControls;
}
