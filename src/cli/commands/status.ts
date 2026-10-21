import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode, Question, RunId, Settings } from "../../contracts/index.js";
import { parseEngineEvent } from "../../contracts/events.js";
import type { EngineState } from "../../engine/reducer.js";
import { applyJournalEvent } from "../../engine/journal.js";
import type { SessionStore } from "../../store/sessions.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
}

export type ParsedCliFlags = CliGlobalFlags & CliGovernanceFlags;

export interface CommandContext {
  cwd: string;
  flags: ParsedCliFlags;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: Engine;
  sessionStore?: SessionStore;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);
const { formatCost, formatElapsed, progressModelsFor } = await import(`../progress.js`);
const { RunReplay, countsOf, mergedOf, outcomeOf, recordOf, requestOf, runPathOf, settingsOf, taskRowsOf } = await import(`../run-observe.js`);

// The view types of run-observe.ts, named from the values above (cli modules are not imported by type).
type RunRecord = ReturnType<typeof recordOf>;
type TaskRow = ReturnType<typeof taskRowsOf>[number];
type RunProgress = NonNullable<InstanceType<typeof RunReplay>["progress"]>;

export function isPassedState(state: string): boolean {
  return state === "PASSED" || state === "MERGED";
}

// Reads a run's events.jsonl through the catalog types only. Complete lines
// that are not catalog events are skipped; a torn final line (partial write)
// is ignored with a warning on stderr.
export function readCatalogEvents(
  eventsPath: string,
  stderr: NodeJS.WriteStream
): ReturnType<typeof parseEngineEvent>[] {
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: ReturnType<typeof parseEngineEvent>[] = [];
  let warned = false;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warned = true;
      continue;
    }
    try {
      events.push(parseEngineEvent(parsed));
    } catch {
      // Not a catalog event: the CLI never reads it.
      continue;
    }
  }
  if (warned) {
    stderr.write(
      `warning: ${eventsPath} contains torn or unparsable lines; complete lines were used\n`
    );
  }
  return events;
}

// The journal's reduction (journal.ts), so a run that finished or failed names that state (R10.2).
export function reduceRunEvents(eventsPath: string, stderr: NodeJS.WriteStream): {
  state: EngineState;
  events: ReturnType<typeof parseEngineEvent>[];
} {
  const events = readCatalogEvents(eventsPath, stderr);
  let state: EngineState = {
    run_id: "" as RunId,
    state: "CREATED",
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
  for (const ev of events) {
    state = applyJournalEvent(state, ev);
  }
  return { state, events };
}

function findLatestRunId(runsDir: string): string | null {
  if (!fs.existsSync(runsDir)) return null;
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const candidates: { id: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("r_")) {
      const full = path.join(runsDir, entry.name);
      try {
        const stat = fs.statSync(full);
        candidates.push({ id: entry.name, mtime: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].id;
}

/** The request's first 200 characters, as `status` shows it (R10.2). */
function requestPreview(request: string): string {
  return request.length > 200 ? request.slice(0, 200) : request;
}

/** Seconds, as `status` prints a task's running time: `34s`, or `2m05s` past a minute. */
function ageText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The lines a live header names for a run: its phase, process, tasks, log and next commands (R10.2). */
function liveHeader(
  record: RunRecord,
  view: { settings: Settings | undefined; rows: TaskRow[]; next: string[]; now: number; elapsedS: number },
  progress: RunProgress | undefined,
): string[] {
  const id = record.runId;
  const { settings, rows, next, now, elapsedS } = view;
  const request = requestOf(record.events);
  const counts = countsOf(rows);
  const planner = settings !== undefined ? progressModelsFor(settings).planner : undefined;
  const worker = settings !== undefined ? progressModelsFor(settings).worker : undefined;
  const merge = settings?.git?.auto_merge === true ? "on" : "off";
  const budget = settings?.budgets?.run?.max_usd;
  const lastActivity = record.lastEventAt !== undefined ? Math.max(0, Math.floor((now - record.lastEventAt) / 1000)) : undefined;
  const processLine = record.process === undefined
    ? record.terminal ? "Process: none (the run has ended)" : `Process: not running (stopped; resume with: substrate resume ${id})`
    : record.process.alive
      ? `Process: pid ${record.process.pid} alive`
      : `Process: not running (stopped; resume with: substrate resume ${id})`;
  const cost = formatCost(record.state.usage.total_usd);
  const budgetText = budget !== undefined && budget !== null ? ` (budget $${Number(budget).toFixed(2)})` : "";
  const countText = [
    `${counts.passed} passed`,
    `${counts.running} running`,
    `${counts.failed} failed`,
    `${counts.waiting} waiting`,
    ...(counts.skipped > 0 ? [`${counts.skipped} skipped`] : []),
  ].join(", ");
  const lines = [
    `Run ${id}  ${record.status}   elapsed ${formatElapsed(elapsedS * 1000)}   request: ${requestPreview(request)}`,
    `Planner ${planner ?? "-"}   Worker ${worker ?? "-"}   merge: ${merge}`,
    `Phase:  ${record.terminal ? "ended" : (progress?.phase ?? "-")}     last activity ${lastActivity !== undefined ? `${lastActivity}s ago` : "never"}     Cost ${cost}${budgetText}`,
    processLine,
    `Tasks: ${countText}`,
  ];
  for (const row of rows) {
    const title = (row.title ?? "").padEnd(32);
    let detail = "";
    if (row.state === "passed") detail = `gen ${row.generation}  ${formatCost(row.cost_usd)}${row.merged ? "  merged" : ""}`;
    else if (row.state === "running") {
      const since = row.started_at !== null ? Math.max(0, Math.floor((now - Date.parse(row.started_at)) / 1000)) : undefined;
      detail = `gen ${row.generation}  attempt ${row.attempt}${since !== undefined ? `  ${ageText(since)}` : ""}`;
    } else if (row.state === "failed") detail = row.failure_class ?? "";
    else if (row.state === "waiting" && row.depends_on.length > 0) detail = `after ${row.depends_on.join(", ")}`;
    lines.push(`  ${row.id.padEnd(4)}${title} ${row.state.padEnd(8)} ${detail}`.replace(/\s+$/, ""));
  }
  lines.push(`Log:   ${runPathOf(id, "progress.log")}`);
  if (next.length > 0) lines.push(`Next:  ${next.join("   (or: ")}${next.length > 1 ? ")" : ""}`);
  return lines;
}

/** The commands a caller can run next for a run in this state (R10.2). */
async function nextOf(cwd: string, record: RunRecord, rows: TaskRow[]): Promise<string[]> {
  const id = record.runId;
  switch (record.status) {
    case "running":
      return [`substrate watch ${id}`];
    case "stopped":
    case "paused":
    case "interrupted":
      return [`substrate resume ${id}`];
    case "finished":
      return mergedOf(cwd, record) ? [] : [`substrate merge ${id}`];
    case "failed": {
      const { failedRunNext } = await import("../../engine/failed-run.js");
      return failedRunNext(id, {
        partialLandable: record.events.some((e) => e.type === "task.merged"),
        planningFailed: rows.length === 0,
        verifyOnly: rows.length > 0 && rows.every((r) => isPassedState(r.state)) && record.events.some((e) => e.type === "integration.failed"),
        internalError: record.events.some((e) => (e.data as { failure_class?: unknown } | undefined)?.failure_class === "internal_error"),
      });
    }
    default:
      return [];
  }
}

export const statusCommand: CliCommand = {
  name: "status",
  description: "Display status and telemetry of current or specified run",
  async execute(ctx: CommandContext): Promise<number> {
    const runsDir = path.join(ctx.cwd, ".substrate", "runs");
    const targetRunId = ctx.rawArgs[0] || findLatestRunId(runsDir);

    if (!targetRunId) {
      ctx.stderr.write("Error: No run found to display status\n");
      return 2;
    }

    const runDir = path.join(runsDir, targetRunId);
    const eventsFile = path.join(runDir, "events.jsonl");

    if (!fs.existsSync(eventsFile)) {
      ctx.stderr.write(`Error: Run '${targetRunId}' not found at ${eventsFile}\n`);
      return 2;
    }

    const { state, events } = reduceRunEvents(eventsFile, ctx.stderr);

    let pendingQuestions: Question[] | undefined;
    const questionsFile = path.join(runDir, "QUESTIONS.md");
    if (state.state === "PAUSED" && state.pause_reason === "needs_human" && fs.existsSync(questionsFile)) {
      const lastPausedIdx = events.map((e) => e.type).lastIndexOf("run.paused");
      const resumedAfterWithAnswers = events
        .slice(lastPausedIdx + 1)
        .some((e) => e.type === "run.resumed" && (e.data as any)?.answers !== undefined);
      if (!resumedAfterWithAnswers) {
        const { parseQuestions } = await import(`../questions.js`);
        pendingQuestions = parseQuestions(fs.readFileSync(questionsFile, "utf8"));
      }
    }

    const taskEntries = Object.entries(state.tasks);
    const taskCount = taskEntries.length;
    const passedCount = taskEntries.filter(([, t]) => isPassedState(t.state)).length;

    // R10.2: the live view. It reads the journal and the run's lock only; it never writes.
    const record = recordOf(ctx.cwd, state.run_id || targetRunId, events);
    const settings = await settingsOf(ctx.cwd, events);
    const rows = taskRowsOf(record);
    const counts = countsOf(rows);
    const now = Date.now();
    const progress = new RunReplay(settings !== undefined ? progressModelsFor(settings) : {}, record.runId);
    for (const ev of events) progress.feed(ev);
    const next = await nextOf(ctx.cwd, record, rows);
    const outcome = outcomeOf(runDir, record.lastEventAt);
    const budget = settings?.budgets?.run?.max_usd ?? null;
    // Elapsed runs to the run's last event once it has ended, else to now.
    const endAt = record.terminal && record.lastEventAt !== undefined ? record.lastEventAt : now;
    const elapsedS = Math.max(0, Math.floor((endAt - (record.createdAt ?? endAt)) / 1000));
    const request = requestOf(events);
    const planner = settings !== undefined ? progressModelsFor(settings).planner : undefined;
    const worker = settings !== undefined ? progressModelsFor(settings).worker : undefined;

    if (ctx.flags.outputFormat === "json") {
      const payload = {
        run_id: state.run_id || targetRunId,
        state: state.state,
        pause_reason: state.pause_reason,
        ...(pendingQuestions ? { questions: pendingQuestions } : {}),
        passed: passedCount,
        total: taskCount,
        tasks: Object.fromEntries(
          taskEntries.map(([id, t]) => [
            id,
            {
              state: t.state,
              generation: t.generation,
              attempt: t.attempt,
              failure_class: t.failure_class,
            },
          ])
        ),
        usage: state.usage,
        // R10.2: the live view. `tasks` above is kept as it was; the task rows are `task_list`.
        status: record.status,
        phase: record.terminal ? "ended" : (progress.progress?.phase ?? "starting"),
        elapsed_s: elapsedS,
        last_event_ts: record.lastEventAt !== undefined ? new Date(record.lastEventAt).toISOString() : null,
        cost_usd: state.usage.total_usd,
        budget_usd: typeof budget === "number" ? budget : null,
        process: record.process ? { pid: record.process.pid, alive: record.process.alive } : null,
        request: requestPreview(request),
        planner: planner ?? null,
        worker: worker ?? null,
        task_list: rows.map((r) => ({
          id: r.id,
          title: r.title,
          class: r.class,
          state: r.state,
          depends_on: r.depends_on,
          generation: r.generation,
          attempt: r.attempt,
          cost_usd: r.cost_usd,
          started_at: r.started_at,
          merged: r.merged,
        })),
        counts,
        log: runPathOf(record.runId, "progress.log"),
        next,
        ...(record.terminal
          ? {
              summary: outcome.summary_path !== undefined ? runPathOf(record.runId, "summary.txt") : null,
              result: outcome.result_path !== undefined ? runPathOf(record.runId, "result.json") : null,
            }
          : {}),
      };
      ctx.stdout.write(JSON.stringify(payload) + "\n");
      return 0;
    }

    for (const line of liveHeader(record, { settings, rows, next, now, elapsedS }, progress.progress)) {
      ctx.stdout.write(`${line}\n`);
    }
    if (record.terminal && (outcome.summary_path !== undefined || outcome.result_path !== undefined)) {
      const files = [outcome.summary_path !== undefined ? "summary.txt" : undefined, outcome.result_path !== undefined ? "result.json" : undefined];
      ctx.stdout.write(`Outcome: ${files.filter((f) => f !== undefined).join(", ")} in .substrate/runs/${record.runId}/\n`);
    }
    ctx.stdout.write(`\n=== Run Status ===\n`);
    ctx.stdout.write(`Run ID:      ${state.run_id || targetRunId}\n`);
    ctx.stdout.write(`State:       ${state.state}\n`);
    if (state.pause_reason) {
      ctx.stdout.write(`Pause Reason: ${state.pause_reason}\n`);
    }
    ctx.stdout.write(`Tasks:       ${passedCount}/${taskCount} passed\n`);
    ctx.stdout.write(`Total Cost:  $${state.usage.total_usd.toFixed(2)}\n`);

    if (pendingQuestions && pendingQuestions.length > 0) {
      ctx.stdout.write(`\nPending Questions:\n`);
      for (const q of pendingQuestions) {
        const defStr = q.default !== undefined ? ` (default: ${q.default})` : "";
        ctx.stdout.write(`  [${q.id}] ${q.text}${defStr}\n`);
      }
    }

    if (taskCount > 0) {
      ctx.stdout.write(`\nID\tState\tGen\tAtt\tFailure\n`);
      ctx.stdout.write(`------------------------------------------------\n`);
      for (const [id, t] of taskEntries) {
        ctx.stdout.write(
          `${id}\t${t.state}\t${t.generation}\t${t.attempt}\t${t.failure_class ?? "-"}\n`
        );
      }
    }

    return 0;
  },
};

registry.register(statusCommand);
