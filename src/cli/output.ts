import type { EngineEvent, Question, RunId, RunSummary } from "../contracts/index.js";
import { MERGE_TURNED_OFF_REASON, TEXT_FILES_LIMIT } from "../engine/landing.js";
import { failedRunNext } from "../engine/failed-run.js";

const { streamTypeFor } = await import(`./stream-map.js`);
const { Heartbeat, RunProgress, followLines, followStderrLine, formatCost, heartbeatMsFromEnv, progressLine } =
  await import(`./progress.js`);
type HeartbeatState = InstanceType<typeof Heartbeat>;
type RunProgressState = InstanceType<typeof RunProgress>;

/** Options for the run's formatter. Every field is optional. */
export interface FormatterOptions {
  /** The models the run names, shown on its start line. */
  models?: { planner?: string; worker?: string };
  /** Silence before a heartbeat. Defaults to SUBSTRATE_HEARTBEAT_MS, else 15 s. */
  heartbeatMs?: number;
  /** Clock in milliseconds; tests inject one. */
  now?: () => number;
  /** Receives every progress line and the summary block as text, for the run's progress.log (R10.2). */
  log?: (text: string) => void;
}

export interface StreamResultEvent {
  type: "result";
  subtype: "success" | "error_failed" | "error_budget" | "error_needs_human" | "needs_input";
  is_error: boolean;
  session_id: string;
  run_id: RunId;
  num_tasks: number;
  total_cost_usd: number;
  usage: { by_role: Record<string, number> };
  duration_ms: number;
  questions?: Question[];
  // Where the work landed (R7.4); present on a run summary, not on a resumed run's.
  branch?: string;
  merged?: boolean;
  base_branch?: string;
  files_changed?: string[];
  files_changed_total?: number;
  next?: string[];
  failure_class?: string;
  message?: string;
  drafts_dir?: string;
}

export interface OutputFormatter {
  onEvent(event: EngineEvent): void;
  onSummary(summary: RunSummary, sessionId: string): void;
  onError(error: Error | string): void;
  flush(): Promise<void>;
  /** A resumed run that emits no run.resumed event of its own: prints the resume's start line (R10.2). */
  beginResume(runId: string): void;
  /** The summary block the last onSummary rendered as text (the summary.txt content), once it ran. */
  renderedSummary(): string | undefined;
}

/**
 * Where the text renderer's output goes (R10.2): the stream (stdout in text mode, none in json
 * modes), the run's progress log, and, while the summary renders, a capture of the summary block.
 */
class TextSink {
  capture: string[] | undefined;

  constructor(
    private readonly stream: NodeJS.WriteStream | undefined,
    private readonly log: ((text: string) => void) | undefined,
  ) {}

  write(text: string): void {
    this.stream?.write(text);
    this.log?.(text);
    this.capture?.push(text);
  }
}

/** The result object `--output-format json` prints for a run's summary; result.json holds the same object (R10.2). */
export function summaryPayload(summary: RunSummary, sessionId: string, events: EngineEvent[]): Record<string, unknown> {
  const lastPaused = [...events].reverse().find((e) => e.type === "run.paused");
  const questions = summary.questions ?? (lastPaused?.data as any)?.questions;
  const isNeedsInput = summary.pause_reason === "needs_human" && questions !== undefined;
  return {
    ...summary,
    ...(isNeedsInput ? { subtype: "needs_input", run_id: summary.run_id, questions } : {}),
    session_id: sessionId,
    events,
  };
}

// The run announcements (R10.2): a run's start or resume names how to follow it from elsewhere.
function bannerOf(event: EngineEvent): string | undefined {
  if (event.type === "run.created") return "started";
  if (event.type === "run.resumed") return "resumed";
  return undefined;
}

function isPassedTask(t: { state: string }): boolean {
  return t.state === "PASSED" || t.state === "MERGED";
}

function countPassed(summary: RunSummary): number {
  const tasks = summary.tasks ?? {};
  return Object.values(tasks).filter((t) => isPassedTask(t as { state: string })).length;
}

class TextFormatter implements OutputFormatter {
  private lastPausedQuestions?: Question[];
  private readonly now: () => number;
  private readonly progress: RunProgressState;
  private readonly heartbeat: HeartbeatState;
  private summaryBlock: string | undefined;

  // Text mode writes progress to stdout, in order with the summary, so a caller reading
  // one stream sees the whole run. Errors and warnings stay on stderr. In json modes the
  // stream is absent: the renderer still feeds the progress log (R10.2).
  constructor(
    private readonly out: TextSink,
    private readonly err: NodeJS.WriteStream,
    private readonly options: FormatterOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.progress = new RunProgress(options.models ?? {}, this.now());
    this.heartbeat = new Heartbeat(
      options.heartbeatMs ?? heartbeatMsFromEnv(),
      this.now,
      (at) => this.writeLine(at, this.progress.heartbeatText(at))
    );
  }

  private writeLine(at: number, body: string): void {
    this.out.write(progressLine(body, at, this.progress.startedAt));
  }

  // The announcement that follows a run's start or resume line (R10.2).
  private announce(runId: string, at: number): void {
    for (const line of followLines(runId)) {
      this.writeLine(at, line);
    }
  }

  beginResume(runId: string): void {
    const at = this.now();
    this.heartbeat.start();
    this.writeLine(at, `run ${runId} resumed`);
    this.announce(runId, at);
  }

  renderedSummary(): string | undefined {
    return this.summaryBlock;
  }

  onEvent(event: EngineEvent): void {
    const at = this.now();
    this.heartbeat.start();
    if (event.type === "run.paused") {
      const data = (event.data ?? {}) as Record<string, any>;
      if (Array.isArray(data.questions)) {
        this.lastPausedQuestions = data.questions;
      }
    }
    const lines = this.progress.observe(event, at);
    for (const line of lines) {
      this.writeLine(at, line);
    }
    if (lines.length > 0) {
      this.heartbeat.wrote(at);
    }
    if (bannerOf(event) !== undefined) {
      this.announce(String(event.run_id), at);
    }
  }

  onSummary(summary: RunSummary, sessionId: string): void {
    this.heartbeat.stop();
    this.out.capture = [];
    try {
      this.renderSummary(summary, sessionId);
      this.summaryBlock = this.out.capture.join("");
    } finally {
      this.out.capture = undefined;
    }
  }

  private renderSummary(summary: RunSummary, sessionId: string): void {
    const questions = summary.questions ?? this.lastPausedQuestions;
    const tasks = summary.tasks ?? {};
    const taskKeys = Object.keys(tasks);
    const passed = countPassed(summary);
    const needsInput = summary.pause_reason === "needs_human" && questions !== undefined;

    // R10.1: one line says where the finished work went, just before the run's last line.
    if (summary.status === "finished" && summary.merged !== undefined) {
      const landing = summary.merged
        ? `merged into ${summary.base_branch ?? "HEAD"}`
        : (summary.not_merged_reason ?? "not merged: no changes to merge");
      this.writeLine(this.now(), landing);
    }

    this.writeLine(
      this.now(),
      `run ${summary.run_id} ${summary.status}: ${passed}/${taskKeys.length} passed, ${formatCost(summary.usage?.total_usd ?? 0)}`
    );

    if (needsInput) {
      this.out.write(`\nRun paused: needs input\n\n`);
      for (const q of questions) {
        const defStr = q.default !== undefined ? ` (default: ${q.default})` : "";
        this.out.write(`  [${q.id}] ${q.text}${defStr}\n`);
      }
      this.out.write(`\nsubstrate resume ${summary.run_id} --answers <file>\n`);
    }

    // Four decimals, as the progress line prints a cost (R9.1).
    const totalCost = formatCost(summary.usage?.total_usd ?? 0);

    this.out.write(`\n--- Run Summary ---\n`);
    this.out.write(`Run ID:     ${summary.run_id}\n`);
    this.out.write(`Session ID: ${sessionId}\n`);
    this.out.write(`Status:     ${summary.status}\n`);
    this.out.write(`Branch:     ${summary.branch ?? "(none, planning failed)"}\n`);
    // R8.1: the summary names every task's outcome, so a partial run reads as what it is.
    const countState = (state: string): number =>
      Object.values(tasks).filter((t) => (t as { state: string }).state === state).length;
    const failedCount = countState("FAILED");
    const skippedCount = countState("SKIPPED");
    const breakdown = [
      `${passed} passed`,
      ...(failedCount > 0 ? [`${failedCount} failed`] : []),
      ...(skippedCount > 0 ? [`${skippedCount} skipped`] : []),
    ].join(", ");
    this.out.write(`Tasks:      ${breakdown} / ${taskKeys.length} total\n`);
    this.out.write(`Total Cost: ${totalCost}\n`);
    this.out.write(`Exit Code:  ${summary.exit_code}\n`);
    // The run command lands the run before the summary, so `merged` is known. A summary without
    // it (a resumed run) falls back to the task merges seen in the events.
    const merged = summary.merged ?? this.progress.merged > 0;
    this.out.write(`Merged:     ${merged ? "yes" : "no"}\n`);
    const landed = summary.merged !== undefined;
    if (landed && summary.drafts_dir === undefined && summary.branch !== undefined) {
      this.writeResult(summary);
    }
    // Only a failed run is "NOT merged: N of M failed"; an interrupted run is paused (R8.2).
    if (summary.status === "failed" && summary.branch !== undefined && passed > 0 && !summary.merged) {
      // A partial run lands nothing: the passed work stays on the run branch (R8.1).
      this.out.write(
        `NOT merged: ${failedCount + skippedCount} of ${taskKeys.length} tasks failed or were skipped; ` +
          `the ${passed} passed ${passed === 1 ? "task stays" : "tasks stay"} on branch ${summary.branch}\n`,
      );
    }
    if (summary.drafts_dir !== undefined || (!landed && summary.exit_code !== 0)) {
      this.out.write(`Drafts and logs: .substrate/runs/${summary.run_id}/\n`);
      if (!needsInput) {
        if (summary.status === "failed") {
          // R10.4: a failed run is resumed: its Next lines lead with the resume, then the partial landing of a
          // passed task (when the plan has integration verify), then a new request. Continuation lines align.
          const partialLandable = summary.next?.some((c) => c.includes(" --partial")) === true;
          const planningFailed = Object.keys(summary.tasks ?? {}).length === 0;
          const internalError = summary.failure_class === "internal_error";
          const verifyOnly = summary.failure_class === "integration_failed" && Object.values(summary.tasks ?? {}).every((t) => t.state === "PASSED");
          const lines = failedRunNext(summary.run_id, { partialLandable, planningFailed, verifyOnly, internalError });
          this.out.write(`Next:       ${lines[0]}\n`);
          for (const line of lines.slice(1)) this.out.write(`            ${line}\n`);
        } else {
          // Without a branch the run failed in planning, and resuming plans again (R7.9).
          const replan = summary.branch === undefined ? "  (re-runs planning; costs again)" : "";
          // A budget stop names the resume with a higher budget (R8.2); other runs name plain resume.
          const resume = summary.next?.find((c) => c.startsWith("substrate resume ")) ?? `substrate resume ${summary.run_id}`;
          this.out.write(`Next:       ${resume}${replan}\n`);
        }
      }
      if (summary.failure_class !== undefined) {
        const message = summary.message ? `: ${summary.message}` : "";
        // An internal error reads as one phrase: `internal error: <message>` (R9.1).
        const label = summary.failure_class === "internal_error" ? "internal error" : summary.failure_class;
        this.out.write(`Reason:     ${label}${message}\n`);
      }
    }
    // R8.2: an interrupted run says how to continue, in the words a caller can copy.
    if (summary.pause_reason === "user_cancel") {
      this.out.write(`Interrupted. Resume with: substrate resume ${summary.run_id}\n`);
    }
  }

  // The landing block: where the work is, and the file names (up to TEXT_FILES_LIMIT).
  private writeResult(summary: RunSummary): void {
    const count = summary.files_changed_total ?? 0;
    const base = summary.base_branch ?? "HEAD";
    const turnedOff = summary.not_merged_reason === MERGE_TURNED_OFF_REASON;
    // R10.1: a finished run kept on its branch because merging was turned off says so and names the merge command.
    if (!summary.merged && turnedOff && summary.status === "finished") {
      this.out.write(`Result:     finished: work is on branch ${summary.branch}, not merged (merging was turned off)\n`);
      this.out.write(`Next:       substrate merge ${summary.run_id}\n`);
    } else if (!summary.merged && summary.status === "finished" && count > 0) {
      // R9.1: a finished run whose branch holds the work, and which is not merged, says so in one line.
      this.out.write(`Result:     finished: work is on branch ${summary.branch}, not merged yet\n`);
    } else {
      this.out.write(`Result:     ${count} files changed on branch ${summary.branch}\n`);
    }
    if (summary.merged) {
      this.out.write(`Merged into ${base} (working tree updated)\n`);
    } else if (summary.not_merged_reason !== undefined && !turnedOff) {
      this.out.write(`${summary.not_merged_reason}\n`);
    } else if (!turnedOff) {
      this.out.write(`NOT merged into ${base} yet — run: substrate merge ${summary.run_id}\n`);
    }
    const files = summary.files_changed ?? [];
    if (files.length > 0) {
      this.out.write(`Files:\n`);
      for (const file of files.slice(0, TEXT_FILES_LIMIT)) {
        this.out.write(`  ${file}\n`);
      }
      const more = count - Math.min(files.length, TEXT_FILES_LIMIT);
      if (more > 0) {
        this.out.write(`  ... and ${more} more\n`);
      }
    }
  }

  onError(error: Error | string): void {
    this.heartbeat.stop();
    const msg = error instanceof Error ? error.message : String(error);
    this.err.write(`Error: ${msg}\n`);
  }

  async flush(): Promise<void> {
    this.heartbeat.stop();
  }
}

class JsonFormatter implements OutputFormatter {
  private readonly events: EngineEvent[] = [];
  // The text renderer runs silently: its lines go to the progress log only (R10.2).
  private readonly text: TextFormatter;

  // The announcement goes to stderr when a stderr stream is given; without one, nothing is written beside stdout.
  constructor(
    private readonly out: NodeJS.WriteStream,
    private readonly err: NodeJS.WriteStream | undefined,
    options: FormatterOptions = {},
  ) {
    this.text = new TextFormatter(new TextSink(undefined, options.log), err ?? out, options);
  }

  onEvent(event: EngineEvent): void {
    this.events.push(event);
    this.text.onEvent(event);
    const verb = bannerOf(event);
    if (verb !== undefined) this.err?.write(followStderrLine(String(event.run_id), verb as "started" | "resumed"));
  }

  beginResume(runId: string): void {
    this.text.beginResume(runId);
    this.err?.write(followStderrLine(runId, "resumed"));
  }

  renderedSummary(): string | undefined {
    return this.text.renderedSummary();
  }

  // JSON mode: exactly one JSON object on stdout, nothing else.
  onSummary(summary: RunSummary, sessionId: string): void {
    this.text.onSummary(summary, sessionId);
    this.out.write(JSON.stringify(summaryPayload(summary, sessionId, this.events)) + "\n");
  }

  onError(error: Error | string): void {
    const msg = error instanceof Error ? error.message : String(error);
    this.out.write(JSON.stringify({ error: msg }) + "\n");
  }

  async flush(): Promise<void> {
    // Write stream flushed
  }
}

class StreamJsonFormatter implements OutputFormatter {
  private readonly startTime = Date.now();
  private readonly events: EngineEvent[] = [];
  private readonly now: () => number;
  private readonly progress: RunProgressState;
  private readonly heartbeat: HeartbeatState;
  private readonly text: TextFormatter;

  constructor(
    private readonly out: NodeJS.WriteStream,
    private readonly err: NodeJS.WriteStream | undefined,
    options: FormatterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.progress = new RunProgress(options.models ?? {}, this.now());
    this.text = new TextFormatter(new TextSink(undefined, options.log), err ?? out, options);
    // A heartbeat object, not an engine event: { type: "heartbeat", elapsed_s, phase, ... }.
    this.heartbeat = new Heartbeat(
      options.heartbeatMs ?? heartbeatMsFromEnv(),
      this.now,
      (at) => this.out.write(JSON.stringify(this.progress.heartbeatRecord(at)) + "\n")
    );
  }

  beginResume(runId: string): void {
    this.text.beginResume(runId);
    this.err?.write(followStderrLine(runId, "resumed"));
  }

  renderedSummary(): string | undefined {
    return this.text.renderedSummary();
  }

  onEvent(event: EngineEvent): void {
    this.events.push(event);
    const at = this.now();
    this.heartbeat.start();
    this.progress.observe(event, at);
    this.text.onEvent(event);
    const verb = bannerOf(event);
    if (verb !== undefined) this.err?.write(followStderrLine(String(event.run_id), verb as "started" | "resumed"));
    this.heartbeat.wrote(at);

    const data = (event.data && typeof event.data === "object")
      ? (event.data as Record<string, any>)
      : {};

    const payload: Record<string, any> = {
      type: streamTypeFor(event.type),
      run_id: event.run_id,
      seq: event.seq,
      ts: event.ts,
      ...data,
    };

    this.out.write(JSON.stringify(payload) + "\n");
  }

  onSummary(summary: RunSummary, sessionId: string): void {
    this.heartbeat.stop();
    this.text.onSummary(summary, sessionId);
    const lastPaused = [...this.events].reverse().find((e) => e.type === "run.paused");
    const questions = summary.questions ?? (lastPaused?.data as any)?.questions;

    let subtype: "success" | "error_failed" | "error_budget" | "error_needs_human" | "needs_input" = "success";
    let is_error = false;

    if (summary.status === "finished") {
      const anyFailed = Object.values(summary.tasks ?? {}).some(
        (t: any) => t.state === "failed" || t.failure_class !== undefined,
      );
      if (anyFailed || summary.exit_code !== 0) {
        subtype = "error_failed";
        is_error = true;
      } else {
        subtype = "success";
        is_error = false;
      }
    } else if (
      summary.pause_reason === "budget_exhausted" ||
      summary.exit_code === 4
    ) {
      subtype = "error_budget";
      is_error = true;
    } else if (summary.pause_reason === "needs_human" && questions !== undefined) {
      subtype = "needs_input";
      is_error = false;
    } else if (
      summary.pause_reason === "needs_human" ||
      summary.pause_reason === "needs_approval" ||
      summary.pause_reason === "permission_denied" ||
      summary.exit_code === 3
    ) {
      subtype = "error_needs_human";
      is_error = true;
    } else {
      subtype = "error_failed";
      is_error = true;
    }

    const num_tasks = Object.keys(summary.tasks ?? {}).length;
    const total_cost_usd = summary.usage?.total_usd ?? 0;
    const usage = { by_role: summary.usage?.by_role ?? {} };
    const duration_ms = Date.now() - this.startTime;

    const resultEvent: StreamResultEvent = {
      type: "result",
      subtype,
      is_error,
      session_id: sessionId,
      run_id: summary.run_id,
      num_tasks,
      total_cost_usd,
      usage,
      duration_ms,
      ...(summary.branch !== undefined ? { branch: summary.branch } : {}),
      ...(questions !== undefined ? { questions } : {}),
      ...landingFields(summary),
    };

    this.out.write(JSON.stringify(resultEvent) + "\n");
  }

  onError(error: Error | string): void {
    this.heartbeat.stop();
    const msg = error instanceof Error ? error.message : String(error);
    const errEvent = {
      type: "result",
      subtype: "error_failed" as const,
      is_error: true,
      error: msg,
    };
    this.out.write(JSON.stringify(errEvent) + "\n");
  }

  async flush(): Promise<void> {
    this.heartbeat.stop();
  }
}

// The landing fields of a summary that carries them (see src/engine/landing.ts).
function landingFields(summary: RunSummary): Partial<StreamResultEvent> {
  const fields: Partial<StreamResultEvent> = {};
  if (summary.merged !== undefined) fields.merged = summary.merged;
  if (summary.base_branch !== undefined) fields.base_branch = summary.base_branch;
  if (summary.files_changed !== undefined) fields.files_changed = summary.files_changed;
  if (summary.files_changed_total !== undefined) fields.files_changed_total = summary.files_changed_total;
  if (summary.next !== undefined) fields.next = summary.next;
  if (summary.failure_class !== undefined) fields.failure_class = summary.failure_class;
  if (summary.message !== undefined) fields.message = summary.message;
  if (summary.drafts_dir !== undefined) fields.drafts_dir = summary.drafts_dir;
  return fields;
}

/**
 * The summary block of a run, rendered from its summary alone, for a run whose summary.txt is
 * missing (R10.2). The block is timed from `startAt` to `endAt`, the run's first and last events.
 */
export function renderSummaryText(
  summary: RunSummary,
  sessionId: string,
  times: { startAt: number; endAt: number },
): string {
  let clock = times.startAt;
  const formatter = new TextFormatter(new TextSink(undefined, undefined), process.stderr, { now: () => clock });
  clock = times.endAt;
  formatter.onSummary(summary, sessionId);
  return formatter.renderedSummary() ?? "";
}

export function createFormatter(
  format: "text" | "json" | "stream-json",
  out: NodeJS.WriteStream,
  err?: NodeJS.WriteStream,
  options: FormatterOptions = {},
): OutputFormatter {
  switch (format) {
    case "json":
      return new JsonFormatter(out, err, options);
    case "stream-json":
      return new StreamJsonFormatter(out, err, options);
    case "text":
    default:
      return new TextFormatter(new TextSink(out, options.log), err ?? out, options);
  }
}

export { countPassed, isPassedTask };
