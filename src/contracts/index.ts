import { z } from "zod";

// ===== identifiers & enums =====
export const RunId = z.string().regex(/^r_[A-Z2-7]{12}$/);
export type RunId = z.infer<typeof RunId>;

export const TaskId = z.string().regex(/^[A-Z][A-Za-z0-9_-]{0,31}$/);
export type TaskId = z.infer<typeof TaskId>;

export const SessionId = z.string();
export type SessionId = z.infer<typeof SessionId>;

export const BackendName = z.enum(["claude", "opencode", "agy", "fake"]);
export type BackendName = z.infer<typeof BackendName>;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

export const RoleName = z.enum(["governor", "planner", "worker", "test-writer", "reviewer"]);
export type RoleName = z.infer<typeof RoleName>;

export const TaskClass = z.string();
export type TaskClass = z.infer<typeof TaskClass>;

export const PermissionMode = z.enum(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const PauseReason = z.enum([
  "needs_approval",
  "permission_denied",
  "budget_exhausted",
  "rate_limited",
  "user_cancel",
  "needs_human",
  "backend_unavailable",
]);
export type PauseReason = z.infer<typeof PauseReason>;

export const FailureClass = z.enum([
  "verify_failed",
  "scope_violation",
  "protected_modified",
  "budget_exceeded",
  "timeout",
  "worker_crashed",
  "permission_denied",
  "rate_limited",
  "merge_conflict",
  "integration_failed",
  "spec_invalid",
]);
export type FailureClass = z.infer<typeof FailureClass>;

// ===== planner artifacts =====
export const Command = z.object({
  run: z.string(),
  cwd: z.string().optional(),
  timeout_s: z.number(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();
export type Command = z.infer<typeof Command>;

export const Budget = z.object({
  max_usd: z.number().optional(),
  max_tokens: z.number().optional(),
  timeout_min: z.number().optional(),
  max_turns: z.number().optional(),
}).strict();
export type Budget = z.infer<typeof Budget>;

export const Manifest = z.object({
  version: z.literal(1),
  run_id: RunId,
  goal: z.string(),
  base_ref: z.string(),
  ecosystem: z.enum(["node-ts", "python", "rust", "go", "other"]).optional(),
  setup: z.array(Command),
  contracts: z.object({
    files: z.array(z.string()),
    typecheck: z.array(Command),
  }).strict(),
  integration_verify: z.array(Command),
  tasks: z.array(z.object({
    id: TaskId,
    spec: z.string(),
  }).strict()),
  budget: z.object({
    max_usd: z.number().optional(),
    max_tokens: z.number().optional(),
    max_wall_min: z.number().optional(),
  }).strict().optional(),
}).strict();
export type Manifest = z.infer<typeof Manifest>;

export const TaskSpecFrontmatter = z.object({
  id: TaskId,
  title: z.string(),
  class: TaskClass,
  depends_on: z.array(TaskId),
  read: z.array(z.string()),
  write: z.array(z.string()),
  create: z.array(z.string()),
  protected: z.array(z.string()),
  verify: z.array(Command).nonempty(),
  effort: Effort.optional(),
  budget: Budget.optional(),
}).strict();
export type TaskSpecFrontmatter = z.infer<typeof TaskSpecFrontmatter>;

// ===== results =====
export const VerifyResult = z.object({
  cmd: z.string(),
  exit_code: z.number().nullable(),
  timed_out: z.boolean(),
  duration_ms: z.number(),
  stdout_tail: z.string(),
  stderr_tail: z.string(),
  truncated: z.boolean(),
}).strict();
export type VerifyResult = z.infer<typeof VerifyResult>;

export const UsageRecord = z.object({
  backend: BackendName,
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  cost_usd: z.number(),
  cost_source: z.enum(["reported", "computed", "unknown"]),
  at: z.string(),
}).strict();
export type UsageRecord = z.infer<typeof UsageRecord>;

// One append-only ledger line per usage.recorded event. Written by
// src/ledger/usage.ts; the run's usage.total_usd must equal the sum of these
// lines' cost_usd for the run.
export const UsageLedgerEntry = z.object({
  v: z.literal(1),
  ts: z.string(),
  project: z.string(),
  run_id: z.string(),
  task_id: TaskId.optional(),
  generation: z.number().optional(),
  attempt: z.number().optional(),
  role: RoleName,
  class: z.string().optional(),
  backend: BackendName,
  model: z.string(),
  effort: Effort.optional(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  cost_usd: z.number(),
  cost_source: z.enum(["reported", "computed", "unknown"]),
}).strict();
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntry>;

export const WorkerReport = z.object({
  task_id: TaskId,
  generation: z.number(),
  attempt: z.number(),
  session_id: SessionId,
  backend: BackendName,
  model: z.string(),
  effort: Effort.optional(),
  status: z.enum(["passed", "failed"]),
  failure_class: FailureClass.optional(),
  files_changed: z.array(z.string()),
  usage: UsageRecord,
  duration_ms: z.number(),
  verify: z.array(VerifyResult),
  denials: z.array(z.string()),
  final_message: z.string(),
}).strict();
export type WorkerReport = z.infer<typeof WorkerReport>;

export const FailurePacket = z.object({
  run_id: RunId,
  task_id: TaskId,
  generation: z.number(),
  failure_class: FailureClass,
  spec_path: z.string(),
  attempts: z.array(WorkerReport),
  diff: z.object({
    stat: z.string(),
    patch_path: z.string(),
    truncated: z.boolean(),
  }).strict(),
  verify_output: z.array(VerifyResult),
  scope_violations: z.array(z.string()),
  worker_summary: z.string(),
  related_contracts: z.array(z.string()),
  dependents: z.array(TaskId),
}).strict();
export type FailurePacket = z.infer<typeof FailurePacket>;

export const Diagnostic = z.object({
  code: z.string(),
  severity: z.enum(["error", "warn", "info", "gate"]),
  task: TaskId.optional(),
  message: z.string(),
  path: z.string().optional(),
}).strict();
export type Diagnostic = z.infer<typeof Diagnostic>;

// ===== backend layer =====
export const BackendEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.started"), session_id: SessionId }).strict(),
  z.object({ type: z.literal("assistant.text"), text: z.string() }).strict(),
  z.object({ type: z.literal("tool.call"), id: z.string(), name: z.string(), input_summary: z.string() }).strict(),
  z.object({ type: z.literal("tool.result"), id: z.string(), ok: z.boolean(), output_summary: z.string() }).strict(),
  z.object({ type: z.literal("permission.denied"), tool: z.string(), reason: z.string().optional() }).strict(),
  z.object({ type: z.literal("usage"), record: UsageRecord, cumulative: z.boolean() }).strict(),
  z.object({ type: z.literal("subagent"), parent_id: z.string().optional(), raw: z.unknown() }).strict(),
  z.object({
    type: z.literal("error"),
    kind: z.enum(["rate_limit", "auth", "crash", "timeout", "protocol"]),
    message: z.string(),
  }).strict(),
  z.object({
    type: z.literal("session.result"),
    ok: z.boolean(),
    stop_reason: z.string().optional(),
    final_text: z.string(),
    usage: UsageRecord.optional(),
    exit_code: z.number().nullable(),
    structured_output: z.unknown().optional(),
  }).strict(),
]);
export type BackendEvent = z.infer<typeof BackendEvent>;

export const Capabilities = z.object({
  name: BackendName,
  version_pin: z.string(),
  effort: z.boolean(),
  structured_output: z.boolean(),
  budget_flag: z.boolean(),
  cost_reported: z.boolean(),
  resume: z.boolean(),
  permission_denial_signal: z.enum(["event", "stderr", "none"]),
  sandbox_flag: z.boolean(),
  native_subagents_headless: z.boolean(),
  max_concurrency: z.number().optional(),
}).strict();
export type Capabilities = z.infer<typeof Capabilities>;

export const SpawnRequest = z.object({
  role: RoleName,
  cwd: z.string(),
  prompt: z.string(),
  system_append: z.string().optional(),
  model: z.string(),
  effort: Effort.optional(),
  permission: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }).strict(),
  json_schema: z.record(z.string(), z.unknown()).optional(),
  budget: z.object({
    max_usd: z.number().optional(),
    max_tokens: z.number().optional(),
    timeout_min: z.number().optional(),
    max_turns: z.number().optional(),
    timeout_ms: z.number(),
  }).strict(),
  env: z.record(z.string(), z.string()).optional(),
  add_dirs: z.array(z.string()).optional(),
  session: z.object({
    id: SessionId.optional(),
    resume: SessionId.optional(),
    fork: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type SpawnRequest = z.infer<typeof SpawnRequest>;

export const SessionResult = z.object({
  ok: z.boolean(),
  session_id: SessionId,
  final_text: z.string(),
  usage: UsageRecord,
  exit_code: z.number().nullable(),
  denials: z.array(z.object({
    tool: z.string(),
    reason: z.string().optional(),
  }).strict()),
  killed_for: z.enum(["budget", "timeout", "cancel"]).optional(),
}).strict();
export type SessionResult = z.infer<typeof SessionResult>;

export const SessionHandle = z.object({
  pid: z.number(),
  events: z.custom<AsyncIterable<BackendEvent>>((v) => v != null && typeof (v as any)[Symbol.asyncIterator] === "function"),
  result: z.custom<() => Promise<SessionResult>>((v) => typeof v === "function"),
  kill: z.custom<(reason: "budget" | "timeout" | "cancel") => Promise<void>>((v) => typeof v === "function"),
});
export type SessionHandle = {
  pid: number;
  events: AsyncIterable<BackendEvent>;
  result(): Promise<SessionResult>;
  kill(reason: "budget" | "timeout" | "cancel"): Promise<void>;
};

export const EnvReport = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  pin_matches: z.boolean(),
  problems: z.array(z.string()),
}).strict();
export type EnvReport = z.infer<typeof EnvReport>;

export const HarnessAdapter = z.object({
  capabilities: Capabilities,
  validateEnvironment: z.custom<() => Promise<EnvReport>>((v) => typeof v === "function"),
  spawn: z.custom<(req: SpawnRequest) => SessionHandle>((v) => typeof v === "function"),
});
export type HarnessAdapter = {
  readonly capabilities: Capabilities;
  validateEnvironment(): Promise<EnvReport>;
  spawn(req: SpawnRequest): SessionHandle;
};

// ===== settings =====
export const Route = z.object({
  backend: BackendName,
  model: z.string(),
  effort: Effort.optional(),
}).strict();
export type Route = z.infer<typeof Route>;

export const PricingTable = z.object({
  asOf: z.string(),
  sources: z.array(z.string()),
  models: z.record(z.string(), z.object({
    input_per_mtok: z.number(),
    output_per_mtok: z.number(),
    cache_read_per_mtok: z.number().optional(),
    cache_write_per_mtok: z.number().optional(),
  }).strict()),
}).strict();
export type PricingTable = z.infer<typeof PricingTable>;

export const ExecutionStrategy = z.enum(["direct", "dispatcher"]);
export type ExecutionStrategy = z.infer<typeof ExecutionStrategy>;

export const Settings = z.object({
  backends: z.record(z.string(), z.object({
    bin: z.string().optional(),
    version_pin: z.string().optional(),
    max_concurrency: z.number().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }).strict()),
  roles: z.object({
    planner: Route,
    worker: Route.optional(),
    reviewer: Route.extend({ enabled: z.boolean() }).strict().optional(),
    governor: z.object({
      enabled: z.boolean(),
      endpoint: z.string(),
      model: z.string().optional(),
      enable_thinking: z.boolean(),
      timeout_s: z.number(),
      max_clarifying_turns: z.number().optional(),
    }).strict().optional(),
  }).strict(),
  routing: z.record(z.string(), z.union([
    Route.extend({ budget: Budget.optional() }).strict(),
    z.array(z.string()),
  ])),
  pricing: PricingTable,
  budgets: z.object({
    run: z.object({
      max_usd: z.number().optional(),
      max_tokens: z.number().optional(),
      max_wall_min: z.number().optional(),
    }).strict(),
    task: Budget,
    l1_replans_per_task: z.number(),
    l2_per_run: z.number(),
    planner_format_retries: z.number(),
    approval_threshold_usd: z.number(),
  }).strict(),
  concurrency: z.object({
    workers: z.number(),
  }).strict(),
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    ask: z.array(z.string()).optional(),
  }).strict(),
  sandbox: z.object({
    enabled: z.boolean(),
    network: z.enum(["deny", "allow"]),
  }).strict(),
  git: z.object({
    on_scope_violation: z.enum(["revert", "fail"]),
    branch_prefix: z.string(),
    auto_merge: z.boolean(),
  }).strict(),
  instructions: z.object({
    workers: z.enum(["none", "project"]),
  }).strict(),
  usage: z.object({
    global: z.boolean(),
  }).strict().optional(),
  execution: z.object({
    strategy: ExecutionStrategy,
  }).strict(),
  hooks: z.record(z.string(), z.array(z.object({
    command: z.string(),
    timeout_s: z.number().optional(),
  }).strict())).optional(),
}).strict();
export type Settings = z.infer<typeof Settings>;

// ===== engine API =====
export const RunOptions = z.object({
  prompt: z.string(),
  cwd: z.string(),
  mode: z.enum(["auto", "solo", "plan"]),
  permission_mode: PermissionMode,
  overrides: z.record(z.string(), z.unknown()).optional(),
  resume: RunId.optional(),
  signal: z.custom<AbortSignal>((v) => v instanceof Object).optional(),
  onEvent: z.custom<(e: EngineEvent) => void>((v) => typeof v === "function").optional(),
}).strict();
export type RunOptions = {
  prompt: string;
  cwd: string;
  mode: "auto" | "solo" | "plan";
  permission_mode: PermissionMode;
  overrides?: Partial<Settings>;
  resume?: RunId;
  signal?: AbortSignal;
  onEvent?: (e: EngineEvent) => void;
};

export const RunSummary = z.object({
  run_id: RunId,
  status: z.enum(["finished", "failed", "paused", "cancelled"]),
  pause_reason: PauseReason.optional(),
  tasks: z.record(TaskId, z.object({
    state: z.string(),
    generation: z.number(),
    failure_class: FailureClass.optional(),
  }).strict()),
  usage: z.object({
    total_usd: z.number(),
    by_role: z.record(z.string(), z.number()),
  }).strict(),
  branch: z.string(),
  exit_code: z.number(),
}).strict();
export type RunSummary = z.infer<typeof RunSummary>;

export const EngineEvent = z.object({
  v: z.literal(1),
  seq: z.number(),
  ts: z.string(),
  run_id: RunId,
  type: z.string(),
  data: z.unknown(),
}).strict();
export type EngineEvent = z.infer<typeof EngineEvent>;

export const Engine = z.object({
  run: z.custom<(opts: RunOptions) => Promise<RunSummary>>((v) => typeof v === "function"),
  resume: z.custom<(run_id: RunId, opts?: Partial<RunOptions>) => Promise<RunSummary>>((v) => typeof v === "function"),
});
export type Engine = {
  run(opts: RunOptions): Promise<RunSummary>;
  resume(run_id: RunId, opts?: Partial<RunOptions>): Promise<RunSummary>;
};

// ===== governor front door =====
export const GovernorTool = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("start_run"),
    args: z.object({
      request: z.string(),
      mode: z.enum(["solo", "plan"]).optional(),
      permission_mode: PermissionMode.optional(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal("plan_only"),
    args: z.object({
      request: z.string(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal("resume_run"),
    args: z.object({
      run_id: RunId,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal("run_status"),
    args: z.object({
      run_id: RunId.optional(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal("show_cost"),
    args: z.object({
      run_id: RunId.optional(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal("cancel_run"),
    args: z.object({
      run_id: RunId,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal("ask_user"),
    args: z.object({
      question: z.string(),
    }).strict(),
  }).strict(),
]);
export type GovernorTool = z.infer<typeof GovernorTool>;

export const RoutingDecision = z.object({
  mode: z.enum(["solo", "plan"]),
  task_class: TaskClass.optional(),
  planner_route: z.string().optional(),
  rationale: z.string(),
  needs_clarification: z.array(z.string()).optional(),
}).strict();
export type RoutingDecision = z.infer<typeof RoutingDecision>;
