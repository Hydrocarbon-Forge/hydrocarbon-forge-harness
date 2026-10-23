import type { EngineEvent, Settings } from "../contracts/index.js";

/**
 * The inputs a run was started with, as its run.created event recorded them (R11.1). A resume reads
 * these instead of its own options: the request text, the mode, the landing, the worker count, the
 * models, the verify and context lists, the tool lists, the sandbox and the history flag. Logs written before a field existed leave it undefined, and the project setting applies.
 */
export interface RecordedRun {
  prompt?: string;
  mode?: string;
  permission_mode?: string;
  merge?: boolean;
  concurrency?: number;
  requested_roles?: Record<string, unknown>;
  verify?: string[];
  context?: string[];
  permissions?: { allow?: string[]; deny?: string[] };
  sandbox?: boolean;
  history_all?: boolean;
  base_branch?: string;
}

/** The recorded inputs of the run whose log is `events`: its run.created data. An empty object when there is none. */
export function recordedRunOptions(events: readonly EngineEvent[]): RecordedRun {
  const created = events.find((e) => e.type === "run.created");
  if (created === undefined) return {};
  return { ...(created.data as RecordedRun) };
}

/**
 * The settings overrides a recorded run implies. They sit above the project settings and below the
 * overrides a resume is given, so a resume without a flag keeps what the run was started with. Only
 * schema-valid keys: the run-level lists and the history flag are in recordedRunLists.
 */
export function recordedSettingsOverrides(recorded: RecordedRun): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (recorded.permissions !== undefined) out.permissions = recorded.permissions;
  if (recorded.sandbox === true) out.sandbox = { enabled: true };
  if (typeof recorded.concurrency === "number") out.concurrency = { workers: recorded.concurrency };
  return out as Partial<Settings>;
}

/**
 * The recorded run-level keys the Settings schema does not have (verify, context, historyAll). The engine
 * merges them into its in-memory settings on resume, so a resumed run keeps its lists; they never go
 * through loadSettings.
 */
export function recordedRunLists(recorded: RecordedRun): { verify?: string[]; context?: string[]; historyAll?: true } {
  const out: { verify?: string[]; context?: string[]; historyAll?: true } = {};
  if (Array.isArray(recorded.verify)) out.verify = recorded.verify;
  if (Array.isArray(recorded.context)) out.context = recorded.context;
  if (recorded.history_all === true) out.historyAll = true;
  return out;
}

/**
 * The inputs a run is created with, for its run.created event (R11.1): the run-level lists (verify,
 * context, permissions), sandbox and history flag the caller gave.
 */
export function runInputsRecord(settings: Settings, overrides: Partial<Settings> | undefined): RecordedRun {
  const given = (overrides ?? {}) as Record<string, unknown>;
  const out: RecordedRun = {};
  if (Array.isArray(given.verify)) out.verify = given.verify as string[];
  if (Array.isArray(given.context)) out.context = given.context as string[];
  if (given.permissions !== undefined && typeof given.permissions === "object") {
    out.permissions = given.permissions as RecordedRun["permissions"];
  }
  if (settings.sandbox?.enabled === true) out.sandbox = true;
  if ((settings as Record<string, unknown>).historyAll === true) out.history_all = true;
  return out;
}
