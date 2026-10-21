import type { EngineEvent, Settings } from "../contracts/index.js";

/**
 * The inputs a run was started with, as its run.created event recorded them (R11.1). A resume reads
 * these instead of its own options: the request text, the mode, the landing, the worker count, the
 * models, the run budget, the verify and context lists, the tool lists, the sandbox and the history
 * flag. Logs written before a field existed leave it undefined, and the project setting applies.
 */
export interface RecordedRun {
  prompt?: string;
  mode?: string;
  permission_mode?: string;
  merge?: boolean;
  concurrency?: number;
  requested_roles?: Record<string, unknown>;
  max_budget_usd?: number;
  verify?: string[];
  context?: string[];
  permissions?: { allow?: string[]; deny?: string[] };
  sandbox?: boolean;
  history_all?: boolean;
  base_branch?: string;
}

/**
 * The recorded inputs of the run whose log is `events`: run.created, except that the budget a later
 * resume recorded (run.resumed or run.reopened with max_budget_usd, when `--max-budget-usd` replaced it)
 * is the one in effect. An empty object when there is no run.created.
 */
export function recordedRunOptions(events: readonly EngineEvent[]): RecordedRun {
  const created = events.find((e) => e.type === "run.created");
  if (created === undefined) return {};
  const recorded: RecordedRun = { ...(created.data as RecordedRun) };
  for (const e of events) {
    if (e.type !== "run.resumed" && e.type !== "run.reopened") continue;
    const cap = (e.data as { max_budget_usd?: unknown } | undefined)?.max_budget_usd;
    if (typeof cap === "number") recorded.max_budget_usd = cap;
  }
  return recorded;
}

/**
 * The settings overrides a recorded run implies. They sit above the project settings and below the
 * overrides a resume is given, so a resume without a flag keeps what the run was started with, and
 * `--max-budget-usd` (or the request's budget) on a resume replaces it.
 */
export function recordedSettingsOverrides(recorded: RecordedRun): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (typeof recorded.max_budget_usd === "number") out.budgets = { run: { max_usd: recorded.max_budget_usd } };
  if (recorded.verify !== undefined) out.verify = recorded.verify;
  if (recorded.context !== undefined) out.context = recorded.context;
  if (recorded.permissions !== undefined) out.permissions = recorded.permissions;
  if (recorded.sandbox === true) out.sandbox = { enabled: true };
  if (typeof recorded.concurrency === "number") out.concurrency = { workers: recorded.concurrency };
  if (recorded.history_all === true) out.historyAll = true;
  return out as Partial<Settings>;
}

/**
 * The inputs a run is created with, for its run.created event (R11.1): the effective run budget, and
 * the run-level lists (verify, context, permissions), sandbox and history flag the caller gave.
 */
export function runInputsRecord(settings: Settings, overrides: Partial<Settings> | undefined): RecordedRun {
  const given = (overrides ?? {}) as Record<string, unknown>;
  const out: RecordedRun = { ...budgetRecord(settings) };
  if (Array.isArray(given.verify)) out.verify = given.verify as string[];
  if (Array.isArray(given.context)) out.context = given.context as string[];
  if (given.permissions !== undefined && typeof given.permissions === "object") {
    out.permissions = given.permissions as RecordedRun["permissions"];
  }
  if (settings.sandbox?.enabled === true) out.sandbox = true;
  if ((settings as Record<string, unknown>).historyAll === true) out.history_all = true;
  return out;
}

/** The run budget in effect, as a field a resume records on its own event (run.resumed or run.reopened). */
export function budgetRecord(settings: Settings): { max_budget_usd?: number } {
  const cap = settings.budgets?.run?.max_usd;
  return typeof cap === "number" ? { max_budget_usd: cap } : {};
}
