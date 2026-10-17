import type { EngineEvent, RunId, RunSummary } from "../contracts/index.js";

export interface StreamResultEvent {
  type: "result";
  subtype: "success" | "error_failed" | "error_budget" | "error_needs_human";
  is_error: boolean;
  session_id: string;
  run_id: RunId;
  num_tasks: number;
  total_cost_usd: number;
  usage: { by_role: Record<string, number> };
  duration_ms: number;
}

export interface OutputFormatter {
  onEvent(event: EngineEvent): void;
  onSummary(summary: RunSummary, sessionId: string): void;
  onError(error: Error | string): void;
  flush(): Promise<void>;
}

class TextFormatter implements OutputFormatter {
  constructor(private readonly out: NodeJS.WriteStream) {}

  onEvent(event: EngineEvent): void {
    if (event.type === "task.started") {
      const data = (event.data ?? {}) as Record<string, any>;
      this.out.write(`[Task ${data.task_id ?? ""}] started: ${data.title ?? ""}\n`);
    } else if (event.type === "task.verified") {
      const data = (event.data ?? {}) as Record<string, any>;
      this.out.write(`[Task ${data.task_id ?? ""}] verified: ${data.verdict ?? "pass"}\n`);
    } else if (event.type === "batch.merged") {
      const data = (event.data ?? {}) as Record<string, any>;
      this.out.write(`[Batch ${data.batch_id ?? ""}] merged\n`);
    }
  }

  onSummary(summary: RunSummary, sessionId: string): void {
    const totalCost = summary.usage?.total_usd !== undefined
      ? summary.usage.total_usd.toFixed(2)
      : "0.00";
    const tasks = summary.tasks ?? {};
    const taskKeys = Object.keys(tasks);
    const passed = taskKeys.filter((k) => tasks[k].state === "verified").length;

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
    this.out.write(`Error: ${msg}\n`);
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

  onSummary(summary: RunSummary, sessionId: string): void {
    const payload = {
      ...summary,
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

  constructor(private readonly out: NodeJS.WriteStream) {}

  onEvent(event: EngineEvent): void {
    const data = (event.data && typeof event.data === "object")
      ? (event.data as Record<string, any>)
      : {};

    let type = event.type;
    if (type === "run.created" && !data.session_id) {
      // Keep run.created or translate
    }

    const payload: Record<string, any> = {
      type,
      run_id: event.run_id,
      seq: event.seq,
      ts: event.ts,
      ...data,
    };

    this.out.write(JSON.stringify(payload) + "\n");
  }

  onSummary(summary: RunSummary, sessionId: string): void {
    let subtype: "success" | "error_failed" | "error_budget" | "error_needs_human" = "success";
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
): OutputFormatter {
  switch (format) {
    case "json":
      return new JsonFormatter(out);
    case "stream-json":
      return new StreamJsonFormatter(out);
    case "text":
    default:
      return new TextFormatter(out);
  }
}
