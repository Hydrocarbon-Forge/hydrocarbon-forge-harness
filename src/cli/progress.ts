import type { EngineEvent, Settings } from "../contracts/index.js";
import { resolvePlannerRoute } from "../roles/router.js";

/** Seconds of silence after which a progress output writes a heartbeat. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Environment variable that overrides the heartbeat interval in milliseconds. */
export const HEARTBEAT_ENV = "SUBSTRATE_HEARTBEAT_MS";

/** The interval from SUBSTRATE_HEARTBEAT_MS, or the default when it is unset or not a positive number. */
export function heartbeatMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HEARTBEAT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_HEARTBEAT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HEARTBEAT_MS;
}

/** mm:ss for an elapsed duration in milliseconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export interface ProgressModels {
  planner?: string;
  worker?: string;
}

export interface PlanTaskView {
  id: string;
  title?: string;
  class?: string;
  depends_on?: string[];
}

/** One line of text from a diagnostic or a message, flattened and capped. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function diagnosticText(d: unknown): string {
  if (typeof d === "string") return oneLine(d, 300);
  if (d && typeof d === "object") {
    const rec = d as Record<string, unknown>;
    const code = typeof rec.code === "string" ? `[${rec.code}] ` : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    return oneLine(`${code}${message}`, 300);
  }
  return "";
}

/**
 * Tracks what a run is doing from its engine events. Text and stream-json output both use
 * it: text turns observed events into progress lines, and both write heartbeats from its
 * phase and cost. Phases are planning, setup, task T<n> running, verifying T<n>, merging
 * T<n>, scheduling (between tasks), and the rest named where they start.
 */
export class RunProgress {
  readonly startedAt: number;
  runId: string | undefined;
  phase = "starting";
  // R8.3: the tasks whose worker session is running, being verified, or being merged. The heartbeat
  // phase names them, so concurrent workers read as "running T1, T2" rather than one task.
  private readonly runningTasks = new Set<string>();
  private readonly verifyingTasks = new Set<string>();
  private readonly mergingTasks = new Set<string>();
  private phaseStartedAt: number;
  private costUsd = 0;
  // Set by the first usage record. Until then no cost has been reported, so a heartbeat
  // says so instead of printing $0.0000 (claude reports a session's cost when it ends).
  private usageSeen = false;
  private plannerAttemptCostUsd = 0;
  private plannerAttempt = 1;
  private readonly taskCostUsd = new Map<string, number>();
  private readonly mergedTasks = new Set<string>();
  // The failure class each task was last reported failed with (R8.2): the replan ladder's give-up
  // repeats the failure a task already printed, and only the first line is shown.
  private readonly failedTasks = new Map<string, string>();
  private pendingPlan: PlanTaskView[] | undefined;

  constructor(
    private readonly models: ProgressModels,
    startedAt: number,
  ) {
    this.startedAt = startedAt;
    this.phaseStartedAt = startedAt;
  }

  /** Tasks whose task.merged event was seen: their branches are in the run branch. */
  get merged(): number {
    return this.mergedTasks.size;
  }

  /**
   * The phase the task events imply: the workers running (one task reads `task T1 running`, several
   * read `running T1, T2`), else the tasks being verified or merged, else `scheduling`.
   */
  private taskPhase(at: number): void {
    const list = (ids: Set<string>): string => [...ids].sort().join(", ");
    if (this.runningTasks.size === 1) this.setPhase(`task ${list(this.runningTasks)} running`, at);
    else if (this.runningTasks.size > 1) this.setPhase(`running ${list(this.runningTasks)}`, at);
    else if (this.verifyingTasks.size > 0) this.setPhase(`verifying ${list(this.verifyingTasks)}`, at);
    else if (this.mergingTasks.size > 0) this.setPhase(`merging ${list(this.mergingTasks)}`, at);
    else this.setPhase("scheduling", at);
  }

  private setPhase(phase: string, at: number): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.phaseStartedAt = at;
  }

  /** Updates the state from one event and returns the text lines it produces (no prefix). */
  observe(event: EngineEvent, at: number): string[] {
    const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, any>;
    const tid: string = typeof data.task_id === "string" ? data.task_id : "";
    // An event with no task id is a plan or run event: a planning failure reads [plan], never [task ].
    const taskLabel = tid !== "" ? `[task ${tid}]` : this.phase === "planning" ? "[plan]" : "[run]";
    if (this.runId === undefined && typeof event.run_id === "string") this.runId = event.run_id;
    // A refused planner attempt: the retry follows, so the attempt's cost closes here.
    if (event.type === "plan.format_rejected") return this.observeFormatRejected(data);

    switch (event.type) {
      case "run.created": {
        const mode = typeof data.mode === "string" ? data.mode : "auto";
        const parts = [`run ${event.run_id} started: mode ${mode}`];
        if (mode !== "solo" && this.models.planner) parts.push(`planner ${this.models.planner}`);
        if (this.models.worker) parts.push(`worker ${this.models.worker}`);
        this.setPhase("starting", at);
        return [parts.join(", ")];
      }
      case "run.resumed":
        this.setPhase("resuming", at);
        return [`run ${event.run_id} resumed`];
      case "run.routed": {
        const why = typeof data.rationale === "string" && data.rationale !== "" ? ` (${data.rationale})` : "";
        return [`routed to ${data.mode === "solo" ? "solo" : "plan"}${why}`];
      }
      case "plan.started":
        this.setPhase("planning", at);
        return [this.models.planner ? `planning with ${this.models.planner}` : "planning"];
      case "usage.recorded": {
        const cost = typeof data.record?.cost_usd === "number" ? data.record.cost_usd : 0;
        this.usageSeen = true;
        this.costUsd += cost;
        if (data.role === "planner") this.plannerAttemptCostUsd += cost;
        if (tid !== "") this.taskCostUsd.set(tid, (this.taskCostUsd.get(tid) ?? 0) + cost);
        return [];
      }
      case "plan.produced": {
        const lines = [`planner attempt ${this.plannerAttempt} finished, ${formatCost(this.plannerAttemptCostUsd)}`];
        this.plannerAttemptCostUsd = 0;
        this.pendingPlan = Array.isArray(data.tasks)
          ? data.tasks.filter((t: any) => t && typeof t.id === "string")
          : [];
        return lines;
      }
      case "contracts.committed":
        return typeof data.note === "string" && data.note !== "" ? [`note: ${data.note}`] : [];
      case "plan.approved":
      case "plan.ready": {
        this.setPhase("setup", at);
        const plan = this.pendingPlan;
        this.pendingPlan = undefined;
        if (plan === undefined) return [];
        const n = plan.length;
        const lines = [`plan ready: ${n} ${n === 1 ? "task" : "tasks"}`];
        for (const t of plan as PlanTaskView[]) {
          const title = t.title ? `  ${t.title}` : "";
          const cls = t.class ? `  [${t.class}]` : "";
          const after = t.depends_on && t.depends_on.length > 0 ? `  after ${t.depends_on.join(", ")}` : "";
          lines.push(`  ${t.id}${title}${cls}${after}`);
        }
        return lines;
      }
      case "plan.rejected": {
        const reason = typeof data.reason === "string" && data.reason !== ""
          ? data.reason
          : (Array.isArray(data.diagnostics) ? data.diagnostics.slice(0, 2).map(diagnosticText).join("; ") : "");
        return [`plan rejected: ${oneLine(reason, 400) || "no detail"}`];
      }
      case "run.paused":
        this.setPhase("paused", at);
        return [`run paused: ${data.reason ?? "unknown"}`];
      case "run.budget.warning":
        return [`budget warning: spent ${formatCost(Number(data.cost_usd ?? 0))}` +
          (typeof data.max_usd === "number" ? ` of $${data.max_usd.toFixed(2)}` : "")];
      case "run.budget.exceeded":
        return [`budget exceeded: spent ${formatCost(Number(data.cost_usd ?? 0))}` +
          (typeof data.max_usd === "number" ? ` of $${data.max_usd.toFixed(2)}` : "")];
      case "task.session.started": {
        this.runningTasks.add(tid);
        this.taskPhase(at);
        const route = data.backend && data.model ? ` on ${data.backend}:${data.model}` : "";
        return [`${taskLabel} started (gen ${data.generation ?? 1}, attempt ${data.attempt ?? 1})${route}`];
      }
      case "task.session.ended":
        this.runningTasks.delete(tid);
        return [`${taskLabel} worker finished, ${formatCost(this.taskCostUsd.get(tid) ?? 0)}`];
      case "task.verify.started":
        this.runningTasks.delete(tid);
        this.verifyingTasks.add(tid);
        this.taskPhase(at);
        return [];
      case "task.verify.finished": {
        this.verifyingTasks.delete(tid);
        if (data.passed) return [`${taskLabel} verify passed`];
        const cmd = typeof data.failed_command === "string" && data.failed_command !== ""
          ? `: ${oneLine(data.failed_command, 200)}`
          : "";
        const out = typeof data.failed_output === "string" && data.failed_output !== ""
          ? ` (${oneLine(data.failed_output, 300)})`
          : "";
        return [`${taskLabel} verify failed${cmd}${out}`];
      }
      case "task.passed":
        this.verifyingTasks.delete(tid);
        this.mergingTasks.add(tid);
        this.taskPhase(at);
        return [];
      case "task.merged":
        if (tid !== "") this.mergedTasks.add(tid);
        this.mergingTasks.delete(tid);
        this.taskPhase(at);
        return [`${taskLabel} merged, ${formatCost(this.taskCostUsd.get(tid) ?? 0)}`];
      case "task.failed": {
        this.runningTasks.delete(tid);
        this.verifyingTasks.delete(tid);
        this.mergingTasks.delete(tid);
        // R8.2: an attempt's own failure is followed by the replan ladder, which prints its own
        // line and, when the task is given up, the one `failed` line for it. The attempt's line
        // is not printed, so a task that fails for good shows `failed` once.
        if (data.attempt !== undefined && data.can_replan === undefined) return [];
        const failureClass = String(data.failure_class ?? "-");
        if (tid !== "" && data.can_replan === false && this.failedTasks.get(tid) === failureClass) return [];
        if (tid !== "") this.failedTasks.set(tid, failureClass);
        const text = typeof data.message === "string" && data.message !== ""
          ? data.message
          : typeof data.detail === "string" ? data.detail : "";
        const reason = text !== "" ? `: ${text}` : "";
        return [`${taskLabel} failed: ${data.failure_class ?? "-"}${reason}`];
      }
      case "task.skipped": {
        // R8.1: a dependent never runs; the line names the upstream task that stopped it.
        const failed: string[] = Array.isArray(data.failed) ? data.failed : [];
        const skipped: string[] = Array.isArray(data.skipped) ? data.skipped : [];
        const upstream = failed.length > 0 ? `${failed.join(", ")}, which failed` : `${skipped.join(", ")}, which was skipped`;
        return [`${taskLabel} skipped (depends on ${upstream})`];
      }
      case "replan.started":
        this.setPhase(`replanning ${tid}`.trimEnd(), at);
        return [];
      case "integration.started":
        this.setPhase("integration verify", at);
        return data.base_verify_passed === false
          ? [
              "integration verify started",
              "note: integration verify does not pass at the base commit (expected when the run adds new code)",
            ]
          : ["integration verify started"];
      case "integration.finished":
        return [`integration verify ${data.passed ? "passed" : "failed"}`];
      case "integration.failed": {
        // R7.11: the failing command and its exit code; older logs carry neither.
        if (typeof data.command !== "string" || data.command === "") return ["integration verify failed"];
        const status = typeof data.exit_code === "number" ? `exit ${data.exit_code}` : "timed out";
        return [`integration verify failed: ${data.command.slice(0, 160)} (${status})`];
      }
      case "merge.conflict": {
        const n = Array.isArray(data.conflict_files) ? data.conflict_files.length : 0;
        return [`${taskLabel} merge conflict in ${n} file${n === 1 ? "" : "s"}`];
      }
      case "rate_limit.backoff":
        return [`${taskLabel} rate limited, concurrency ${data.concurrency ?? "?"}`];
      case "run.finished":
        this.setPhase("finishing", at);
        return [];
      default:
        return [];
    }
  }

  private observeFormatRejected(data: Record<string, any>): string[] {
    const attempt = Number(data.attempt) || 1;
    const max = Number(data.max_attempts) || attempt;
    const errors: unknown[] = Array.isArray(data.errors) ? data.errors : [];
    const first = errors.slice(0, 2).map(diagnosticText).filter((t) => t !== "");
    const lines = [
      `planner attempt ${attempt}/${max} finished, ${formatCost(this.plannerAttemptCostUsd)}`,
      `plan rejected (attempt ${attempt}/${max}): ${first.length > 0 ? first.join("; ") : "no detail"}`,
    ];
    this.plannerAttemptCostUsd = 0;
    this.plannerAttempt = attempt + 1;
    return lines;
  }

  /**
   * The body of a heartbeat line: `still working: <phase> (<s>s, $<cost>)` once a usage record
   * exists. Before that it reads `(<s>s; cost is reported when <planning|this step> ends)`.
   */
  heartbeatText(at: number): string {
    const secs = Math.floor((at - this.phaseStartedAt) / 1000);
    if (!this.usageSeen) {
      const ends = this.phase === "planning" ? "planning" : "this step";
      return `still working: ${this.phase} (${secs}s; cost is reported when ${ends} ends)`;
    }
    return `still working: ${this.phase} (${secs}s, ${formatCost(this.costUsd)})`;
  }

  /** The stream-json heartbeat object. `cost_usd` is null until the first usage record. */
  heartbeatRecord(at: number): Record<string, unknown> {
    return {
      type: "heartbeat",
      run_id: this.runId ?? null,
      ts: new Date(at).toISOString(),
      elapsed_s: Math.floor((at - this.startedAt) / 1000),
      phase: this.phase,
      phase_elapsed_s: Math.floor((at - this.phaseStartedAt) / 1000),
      cost_usd: this.usageSeen ? this.costUsd : null,
    };
  }
}

/**
 * Writes a heartbeat when `intervalMs` has passed since the last progress write. Started
 * by the first event, cleared at the summary. The timer is unref'd so it never holds the
 * process open.
 */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastWriteAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
    private readonly beat: (at: number) => void,
  ) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Starts the timer if it is not running. */
  start(): void {
    if (this.timer !== undefined) return;
    this.lastWriteAt = this.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Records that progress was written at `at`, so the silence count restarts. */
  wrote(at: number): void {
    this.lastWriteAt = at;
  }

  private tick(): void {
    const at = this.now();
    // A 5% allowance keeps a tick that fires a few milliseconds early from skipping a beat.
    if (at - this.lastWriteAt >= this.intervalMs * 0.95) {
      this.lastWriteAt = at;
      this.beat(at);
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The models a run's start line names: the planner route the engine resolves for planning,
 * and the worker role the request or flags set.
 */
export function progressModelsFor(settings: Settings): ProgressModels {
  const planner = resolvePlannerRoute(settings);
  const worker = settings.roles.worker;
  return {
    planner: `${planner.backend}:${planner.model}`,
    worker: worker?.backend && worker.model ? `${worker.backend}:${worker.model}` : undefined,
  };
}
