import type { EngineEvent, Question, RunId, RunSummary } from "../contracts/index.js";

const { streamTypeFor } = await import(`./stream-map.js`);

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
}

export interface OutputFormatter {
  onEvent(event: EngineEvent): void;
  onSummary(summary: RunSummary, sessionId: string): void;
  onError(error: Error | string): void;
  flush(): Promise<void>;
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

  constructor(
    private readonly out: NodeJS.WriteStream,
    private readonly err: NodeJS.WriteStream
  ) {}

  // Text progress: one line per event on stderr, only for the tracked types.
  onEvent(event: EngineEvent): void {
    const data = (event.data ?? {}) as Record<string, any>;
    if (event.type === "task.session.started") {
      this.err.write(
        `[task ${data.task_id ?? ""}] started (gen ${data.generation ?? 1}, attempt ${data.attempt ?? 1})\n`
      );
    } else if (event.type === "task.verify.finished") {
      const verdict = data.passed ? "verify passed" : "verify failed";
      this.err.write(`[task ${data.task_id ?? ""}] ${verdict}\n`);
    } else if (event.type === "task.merged") {
      this.err.write(`[task ${data.task_id ?? ""}] merged\n`);
    } else if (event.type === "task.failed") {
      const reason = typeof data.message === "string" && data.message !== "" ? `: ${data.message}` : "";
      this.err.write(`[task ${data.task_id ?? ""}] failed: ${data.failure_class ?? "-"}${reason}\n`);
    } else if (event.type === "run.paused") {
      if (Array.isArray(data.questions)) {
        this.lastPausedQuestions = data.questions;
      }
      this.err.write(`run paused: ${data.reason ?? "unknown"}\n`);
    }
  }

  onSummary(summary: RunSummary, sessionId: string): void {
    const questions = summary.questions ?? this.lastPausedQuestions;
    if (summary.pause_reason === "needs_human" && questions !== undefined) {
      this.out.write(`\nRun paused: needs input\n\n`);
      for (const q of questions) {
        const defStr = q.default !== undefined ? ` (default: ${q.default})` : "";
        this.out.write(`  [${q.id}] ${q.text}${defStr}\n`);
      }
      this.out.write(`\nsubstrate resume ${summary.run_id} --answers <file>\n`);
    }

    const totalCost = summary.usage?.total_usd !== undefined
      ? summary.usage.total_usd.toFixed(2)
      : "0.00";
    const tasks = summary.tasks ?? {};
    const taskKeys = Object.keys(tasks);
    const passed = countPassed(summary);

    this.out.write(`\n--- Run Summary ---\n`);
    this.out.write(`Run ID:     ${summary.run_id}\n`);
    this.out.write(`Session ID: ${sessionId}\n`);
    this.out.write(`Status:     ${summary.status}\n`);
    this.out.write(`Branch:     ${summary.branch}\n`);
    this.out.write(`Tasks:      ${passed} passed / ${taskKeys.length} total\n`);
    this.out.write(`Total Cost: $${totalCost}\n`);
    this.out.write(`Exit Code:  ${summary.exit_code}\n`);
  }

  onError(error: Error | string): void {
    const msg = error instanceof Error ? error.message : String(error);
    this.err.write(`Error: ${msg}\n`);
  }

  async flush(): Promise<void> {
    // Write stream is flushed synchronously
  }
}

class JsonFormatter implements OutputFormatter {
  private readonly events: EngineEvent[] = [];

  constructor(private readonly out: NodeJS.WriteStream) {}

  onEvent(event: EngineEvent): void {
    this.events.push(event);
  }

  // JSON mode: exactly one JSON object on stdout, nothing else.
  onSummary(summary: RunSummary, sessionId: string): void {
    const lastPaused = [...this.events].reverse().find((e) => e.type === "run.paused");
    const questions = summary.questions ?? (lastPaused?.data as any)?.questions;
    const isNeedsInput = summary.pause_reason === "needs_human" && questions !== undefined;
    const payload = {
      ...summary,
      ...(isNeedsInput ? { subtype: "needs_input", run_id: summary.run_id, questions } : {}),
      session_id: sessionId,
      events: this.events,
    };
    this.out.write(JSON.stringify(payload, null, 2) + "\n");
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

  constructor(private readonly out: NodeJS.WriteStream) {}

  onEvent(event: EngineEvent): void {
    this.events.push(event);

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
      ...(questions !== undefined ? { questions } : {}),
    };

    this.out.write(JSON.stringify(resultEvent) + "\n");
  }

  onError(error: Error | string): void {
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
    // Write stream flushed
  }
}

export function createFormatter(
  format: "text" | "json" | "stream-json",
  out: NodeJS.WriteStream,
  err?: NodeJS.WriteStream,
): OutputFormatter {
  switch (format) {
    case "json":
      return new JsonFormatter(out);
    case "stream-json":
      return new StreamJsonFormatter(out);
    case "text":
    default:
      return new TextFormatter(out, err ?? out);
  }
}

export { countPassed, isPassedTask };
