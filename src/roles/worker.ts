import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import type {
  BackendEvent,
  Command,
  EngineEvent,
  FailureClass,
  HarnessAdapter,
  Route,
  RunId,
  SessionResult,
  Settings,
  SpawnRequest,
  TaskId,
  TaskSpecFrontmatter,
  UsageRecord,
  VerifyResult,
  WorkerReport,
} from "../contracts/index.js";
import type { EventData, EventType } from "../contracts/events.js";
import { toDelta, type UsageTotals } from "../ledger/usage.js";
import { assembleSystem, loadTemplate } from "../prompts/index.js";
import { render } from "../prompts/render.js";
import {
  workspaceManager,
  workspaceLifecycle,
  scopeEnforcer,
  gitCommitter,
} from "../git/index.js";
import { VerifyRunner } from "../verify/index.js";
import { resolveTaskRoute } from "./router.js";
import { bindAbort } from "../backends/process.js";
import { capBytes, HEAL_TAIL_MAX_BYTES } from "../util/index.js";

/** The action's typed emit (R1.2): every event is checked against the catalog. */
export type WorkerEmit = <T extends EventType>(
  type: T,
  data: EventData<T>
) => EngineEvent;

export type WorkerKillReason = "budget" | "timeout" | "cancel";

/** Per-task totals of cost, tokens and turns for one generation (R3.4). */
export interface TaskTotals {
  cost_usd: number;
  tokens: number;
  turns: number;
}

/**
 * What the worker observed: a streamed event with the usage delta computed for it,
 * or the session result once the stream is drained, plus the per-task totals kept
 * for this generation so the action can decide the task budget (R3.4).
 */
export type WorkerObservation = {
  event?: BackendEvent;
  usageDelta?: UsageRecord;
  result?: SessionResult;
  totals?: TaskTotals;
};

/**
 * Run-level policy is the engine action's decision, not the role's (R1.4, R1.5).
 * The worker reports what it observed and the action answers whether this attempt
 * must stop, with which kill reason, which failure class records the task, and with
 * which backoff delay the same attempt is retried (R3.4). The role never decides run
 * policy.
 */
export type WorkerRunPolicy = (
  observation: WorkerObservation
) => WorkerStopDecision;

export interface WorkerStopDecision {
  stop: boolean;
  kill?: WorkerKillReason;
  /** Set when the action decided a task failure, which the worker then emits. */
  failure_class?: FailureClass;
  detail?: string;
  /** Retry the same attempt after this delay; the attempt number is not consumed. */
  backoff_ms?: number;
}

export interface WorkerRunOptions {
  runId: RunId;
  taskId: TaskId;
  spec: TaskSpecFrontmatter;
  specContent: string;
  specAbsPath: string;
  generation: number;
  repoRoot: string;
  settings: Settings;
  /** Adapter for the route's backend (R2.2), handed by the action. */
  adapter: HarnessAdapter;
  baseRef: string;
  /** Run directory: the worker's `raw_dir` (R3.3). */
  rawDir: string;
  setupCommands?: Command[];
  /** Attempt for this call: 1 for a worker action, 2 when the action dispatches a heal. */
  attempt?: number;
  /** Session this attempt uses, decided by the action (R3.2). */
  session?: { id?: string; resume?: string };
  /** Heal prompt input; the action fills it with real verify output in R3.4. */
  healFailures?: string;
  /** Run abort signal, decided by the engine. */
  signal?: AbortSignal;
  runPolicy?: WorkerRunPolicy;
  onEvent?: WorkerEmit;
  /**
   * Each attempt's report is handed to the action as soon as that attempt finishes, so
   * the action can record it (R3.5 rule 2). The role does not write files, so the
   * per-attempt report files are the action's.
   */
  onReport?: (report: WorkerReport) => void;
}

/** Cap for the failures text in the heal prompt (R1.6, R3.4). */
const FAILURE_TAIL_CAP = HEAL_TAIL_MAX_BYTES;

/** One L0 heal per generation. Which failure escalates is the engine ladder (R3.4). */
const HEAL_CAP = 1;

function gitRef(worktreePath: string, args: string[]): string {
  return execFileSync("git", ["-C", worktreePath, ...args], {
    encoding: "utf8",
  }).trim();
}

/**
 * The failures text for the heal prompt, built from the real VerifyResults of
 * attempt 1 (R3.4): command, exit code, then the stdout and stderr tails, capped at
 * 8192 bytes with capBytes.
 */
function formatFailures(results: VerifyResult[]): string {
  const text = results
    .filter((r) => r.exit_code !== 0 || r.timed_out)
    .map((r) => {
      const parts = [`Command: ${r.cmd}`, `Exit code: ${r.exit_code}`];
      if (r.stdout_tail) parts.push(`Stdout:\n${r.stdout_tail}`);
      if (r.stderr_tail) parts.push(`Stderr:\n${r.stderr_tail}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return capBytes(text, FAILURE_TAIL_CAP).text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AttemptBaseline {
  worktreePath: string;
  /** Absolute path of the spec materialised for the worker: `.substrate-task/TASK.md`. */
  specPath: string;
  initialHashes: Map<string, string>;
  head: string;
  branch: string;
}

interface AttemptOutcome {
  report: WorkerReport;
  /** The run policy stopped the attempt: no task event was emitted for it. */
  stopped: boolean;
  /** Verify decided this attempt: the caller heals once or fails the task. */
  verifyFailed: boolean;
  /** The policy decision that stopped the attempt, when it stopped it. */
  decision?: WorkerStopDecision;
}

class AttemptStopped extends Error {
  constructor(public readonly decision: WorkerStopDecision) {
    super("attempt stopped by run policy");
  }
}

/**
 * One attempt of one task: worktree, setup, hashes and HEAD, spawn, usage, scope,
 * verify, commit. Run-level decisions are asked from the action's policy; the worker
 * only observes and records.
 */
async function runAttempt(
  opts: WorkerRunOptions,
  route: Route,
  attempt: number,
  promptText: string,
  session: { id?: string; resume?: string },
  baseline: AttemptBaseline,
  startTime: number,
  sessionTotals: Map<string, UsageTotals>,
  usage: UsageRecord,
  taskTotals: TaskTotals
): Promise<AttemptOutcome> {
  // Per-attempt timeout (R3.4): the timer is armed for every attempt, not only the
  // first, and it kills this attempt's session, never the run.
  const timeoutMs =
    (opts.spec.budget?.timeout_min ?? opts.settings.budgets.task.timeout_min ?? 30) * 60 * 1000;

  const spawnReq: SpawnRequest = {
    role: "worker",
    cwd: baseline.worktreePath,
    prompt: promptText,
    system_append: assembleSystem("worker", { taskClass: opts.spec.class }),
    raw_dir: opts.rawDir,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    session,
    permission: {
      allow: [baseline.worktreePath],
      deny: [
        "git commit",
        "git push",
        "git checkout",
        "git reset",
        "git rebase",
        "git clean",
        "subagents",
      ],
    },
    budget: {
      max_usd: opts.spec.budget?.max_usd ?? opts.settings.budgets.task.max_usd,
      timeout_ms: timeoutMs,
      ...(opts.spec.budget?.max_tokens ? { max_tokens: opts.spec.budget.max_tokens } : {}),
    },
  };

  const handle = opts.adapter.spawn(spawnReq);

  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    void handle.kill("timeout");
  }, timeoutMs);

  let sessionId = session.resume ?? session.id ?? "";
  let sawUsage = false;
  let scopeChanges: string[] = [];
  let verifyResults: VerifyResult[] = [];
  let denials: string[] = [];
  let finalMessage = "";

  // The session id recorded for the attempt is the id the adapter reports. The
  // engine passes the id a new session should use, so the session is recorded in
  // the log at spawn and a kill in flight leaves it as the last event for the task.
  let sessionStartedRecorded = false;
  const recordSessionStarted = (): void => {
    if (sessionStartedRecorded || !sessionId) return;
    sessionStartedRecorded = true;
    opts.onEvent?.("task.session.started", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
    });
  };
  recordSessionStarted();

  const recordUsage = (record: UsageRecord, cumulative: boolean): UsageRecord => {
    const totals = sessionTotals.get(sessionId) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
    const { delta, next } = toDelta(totals, record, cumulative);
    sessionTotals.set(sessionId, next);
    usage.input_tokens += delta.input_tokens;
    usage.output_tokens += delta.output_tokens;
    usage.cost_usd += delta.cost_usd ?? 0;
    // Per-task totals for the generation: cost and input plus output tokens (R3.4).
    taskTotals.cost_usd += delta.cost_usd ?? 0;
    taskTotals.tokens += delta.input_tokens + delta.output_tokens;
    opts.onEvent?.("usage.recorded", {
      record: delta,
      role: "worker",
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
      class: opts.spec.class,
    });
    return delta;
  };

  const buildReport = (
    status: "passed" | "failed",
    failureClass?: FailureClass
  ): WorkerReport => ({
    task_id: opts.taskId,
    generation: opts.generation,
    attempt,
    session_id: sessionId,
    backend: route.backend,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    status,
    ...(failureClass ? { failure_class: failureClass } : {}),
    files_changed: scopeChanges,
    usage,
    duration_ms: Date.now() - startTime,
    verify: verifyResults,
    denials,
    final_message: finalMessage,
  });

  const fail = (failureClass: FailureClass, detail?: string): AttemptOutcome => {
    opts.onEvent?.("task.failed", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
      failure_class: failureClass,
      ...(detail ? { detail } : {}),
    });
    return { report: buildReport("failed", failureClass), stopped: false, verifyFailed: false };
  };

  /** The decision the action made is executed here: kill, record, or retry. */
  const stoppedOutcome = (decision: WorkerStopDecision): AttemptOutcome => {
    const base = decision.failure_class
      ? fail(decision.failure_class, decision.detail)
      : { report: buildReport("failed", undefined), stopped: false, verifyFailed: false };
    return { ...base, stopped: true, decision };
  };

  // Run abort kills this attempt's session; unbind runs once the session has ended.
  const unbind = bindAbort(opts.signal, handle);

  try {
    for await (const event of handle.events) {
      if (event.type === "session.started" && event.session_id) {
        sessionId = event.session_id;
        recordSessionStarted();
      }

      // Assistant turns are counted per generation, across attempt 1 and heal (R3.4).
      if (event.type === "assistant.text") {
        taskTotals.turns += 1;
      }

      let delta: UsageRecord | undefined;
      if (event.type === "usage" && event.record) {
        sawUsage = true;
        delta = recordUsage(event.record, Boolean(event.cumulative));
      }

      const decision = opts.runPolicy?.({
        event,
        usageDelta: delta,
        totals: taskTotals,
      });
      if (decision?.stop) {
        if (decision.kill) await handle.kill(decision.kill);
        throw new AttemptStopped(decision);
      }
    }

    const res = await handle.result();
    if (res?.session_id) sessionId = res.session_id;
    denials = (res.denials ?? []).map((d) => d.tool);
    finalMessage = res.final_text ?? "";

    let resultDelta: UsageRecord | undefined;
    if (!sawUsage && res?.usage) {
      sawUsage = true;
      resultDelta = recordUsage(res.usage, false);
    }

    opts.onEvent?.("task.session.ended", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
    });

    const decision = opts.runPolicy?.({
      result: res,
      usageDelta: resultDelta,
      totals: taskTotals,
    });
    if (decision?.stop) {
      if (decision.kill) await handle.kill(decision.kill);
      throw new AttemptStopped(decision);
    }

    if (!sessionId) return fail("worker_crashed", "adapter reported no session id");

    if (timedOut || res.killed_for === "timeout") {
      return fail("timeout", "session killed for timeout");
    }

    // Rule 6: HEAD and branch must still be what step 3 recorded. Nothing is reverted.
    const headNow = gitRef(baseline.worktreePath, ["rev-parse", "HEAD"]);
    const branchNow = gitRef(baseline.worktreePath, [
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);
    if (headNow !== baseline.head || branchNow !== baseline.branch) {
      return fail("scope_violation", "HEAD or branch changed");
    }

    // Rule 7: scope and protected files are checked before verify.
    const scopeRes = await scopeEnforcer.checkScope(
      baseline.worktreePath,
      opts.spec,
      baseline.initialHashes,
      opts.settings.git.on_scope_violation
    );
    scopeChanges = scopeRes.allowedChanges;

    const scopeData = {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
      ok: scopeRes.ok,
      violations: scopeRes.violations,
      protected_modified: scopeRes.protectedModified,
    };
    opts.onEvent?.("task.scope.checked", scopeData);
    // Legacy name kept for the protected scenario suite (observe-only).
    opts.onEvent?.("scope.checked", scopeData);

    if (scopeRes.protectedModified.length > 0) {
      // The role reports what it observed; which tier handles it is the engine ladder
      // (R3.5 rule 1), so replannability is not decided here.
      opts.onEvent?.("task.failed", {
        task_id: opts.taskId,
        generation: opts.generation,
        attempt,
        failure_class: "protected_modified",
      });
      return {
        report: buildReport("failed", "protected_modified"),
        stopped: false,
        verifyFailed: false,
      };
    }

    if (scopeRes.violations.length > 0 && opts.settings.git.on_scope_violation === "fail") {
      return fail("scope_violation");
    }

    // Rule 8: verify in the worktree, with the settings sandbox, network allowed.
    const runner = new VerifyRunner();
    opts.onEvent?.("task.verify.started", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
    });

    verifyResults = await runner.runVerify({
      cwd: baseline.worktreePath,
      commands: opts.spec.verify ?? [],
      sandbox: opts.settings.sandbox.enabled,
      network: "allow",
    });
    const passed =
      (opts.spec.verify?.length ?? 0) === 0 ? true : runner.isAllPassed(verifyResults);

    const failing = passed ? undefined : verifyResults.find((r) => r.timed_out || r.exit_code !== 0);
    const failingOutput = failing
      ? (failing.stderr_tail.trim() || failing.stdout_tail.trim()).split("\n").pop() ?? ""
      : "";
    opts.onEvent?.("task.verify.finished", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
      passed,
      failure_class: passed ? undefined : "verify_failed",
      ...(failing
        ? {
            failed_command: failing.cmd,
            ...(failingOutput ? { failed_output: failingOutput.slice(0, 300) } : {}),
          }
        : {}),
    });

    if (!passed) {
      return {
        report: buildReport("failed", "verify_failed"),
        stopped: false,
        verifyFailed: true,
      };
    }

    // Rule 9: the engine commits. An empty diff with a passing verify is a pass.
    if (scopeChanges.length > 0) {
      try {
        await gitCommitter.commitAllowed(
          baseline.worktreePath,
          opts.spec,
          `feat(task): ${opts.taskId}`
        );
      } catch {
        return fail("worker_crashed", "commit failed");
      }
    }

    opts.onEvent?.("task.passed", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
    });

    return { report: buildReport("passed"), stopped: false, verifyFailed: false };
  } catch (err) {
    if (err instanceof AttemptStopped) {
      return stoppedOutcome(err.decision);
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
    unbind();
  }
}

/**
 * The one worker path (R3.3), called by the `worker` and `heal` actions. Events go
 * out only through the action's typed emit; raw BackendEvents are not forwarded.
 */
export async function runWorker(opts: WorkerRunOptions): Promise<WorkerReport> {
  const route = resolveTaskRoute(opts.spec.class, opts.generation, opts.settings);
  const startTime = Date.now();
  const attempt = opts.attempt ?? 1;
  const sessionTotals = new Map<string, UsageTotals>();

  const usage: UsageRecord = {
    backend: route.backend,
    model: route.model,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_source: "computed",
    at: new Date().toISOString(),
  };

  // Rule 1: the worktree path carries the run id. An existing worktree is returned,
  // never removed, so resume and heal reuse it.
  const worktree = await workspaceManager.createTaskWorktree(
    opts.repoRoot,
    opts.runId,
    opts.spec,
    opts.generation,
    opts.baseRef
  );

  opts.onEvent?.("task.worktree.created", {
    task_id: opts.taskId,
    path: worktree.worktreePath,
  });

  const specPath = await workspaceManager.materializeSpec(
    worktree.worktreePath,
    opts.specContent
  );

  const baseline: AttemptBaseline = {
    worktreePath: worktree.worktreePath,
    specPath,
    initialHashes: new Map<string, string>(),
    head: "",
    branch: "",
  };

  // Rule 2: manifest setup. A failure fails the task and keeps the worktree.
  if (opts.setupCommands && opts.setupCommands.length > 0) {
    for (const cmd of opts.setupCommands) {
      try {
        await workspaceLifecycle.runSetup(worktree.worktreePath, [cmd]);
      } catch {
        opts.onEvent?.("task.failed", {
          task_id: opts.taskId,
          generation: opts.generation,
          attempt,
          failure_class: "worker_crashed",
          detail: cmd.run,
        });
        return {
          task_id: opts.taskId,
          generation: opts.generation,
          attempt,
          session_id: opts.session?.resume ?? opts.session?.id ?? "",
          backend: route.backend,
          model: route.model,
          ...(route.effort ? { effort: route.effort } : {}),
          status: "failed",
          failure_class: "worker_crashed",
          files_changed: [],
          usage,
          duration_ms: Date.now() - startTime,
          verify: [],
          denials: [],
          final_message: `setup command failed: ${cmd.run}`,
        };
      }
    }
  }

  // Rule 3: protected hashes, HEAD and branch recorded before the spawn.
  baseline.initialHashes = await scopeEnforcer.hashProtectedFiles(
    worktree.worktreePath,
    opts.spec.protected ?? []
  );
  baseline.head = gitRef(worktree.worktreePath, ["rev-parse", "HEAD"]);
  baseline.branch = gitRef(worktree.worktreePath, [
    "symbolic-ref",
    "-q",
    "--short",
    "HEAD",
  ]);

  const taskTotals: TaskTotals = { cost_usd: 0, tokens: 0, turns: 0 };

  // A heal dispatched by the action is recorded by the worker, which is the role that
  // renders the failures (R3.4). On this path the attempt 1 verify results are not in
  // the engine state, so the action supplies the text it has.
  if (attempt >= 2) {
    opts.onEvent?.("task.healing", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
      ...(opts.session?.resume ? { session_id: opts.session.resume } : {}),
      failures: opts.healFailures ?? "",
    });
  }

  const taskPrompt = render(loadTemplate("worker/task.md"), {
    spec_path: baseline.specPath,
  });

  const runWithBackoff = async (
    promptText: string,
    session: { id?: string; resume?: string },
    attemptNumber: number
  ): Promise<AttemptOutcome> => {
    let outcome = await runAttempt(
      opts,
      route,
      attemptNumber,
      promptText,
      session,
      baseline,
      startTime,
      sessionTotals,
      usage,
      taskTotals
    );
    opts.onReport?.(outcome.report);

    // A rate limit backoff retries the same attempt and does not consume the attempt
    // number (R3.4). The worktree and the session are reused, as in a heal.
    while (outcome.stopped && outcome.decision?.backoff_ms && !opts.signal?.aborted) {
      await sleep(outcome.decision.backoff_ms);
      outcome = await runAttempt(
        opts,
        route,
        attemptNumber,
        promptText,
        outcome.report.session_id ? { resume: outcome.report.session_id } : session,
        baseline,
        startTime,
        sessionTotals,
        usage,
        taskTotals
      );
      opts.onReport?.(outcome.report);
    }

    return outcome;
  };

  const first = await runWithBackoff(
    taskPrompt,
    opts.session ?? { id: crypto.randomUUID() },
    attempt
  );

  if (first.stopped) return first.report;

  if (!first.verifyFailed) return first.report;

  // The one L0 heal per generation resumes the same session in the same worktree
  // with the heal template rendered from real verify output. Escalation is the
  // engine ladder (R3.4), so here the first failure gets that one heal.
  if (attempt === 1) {
    const failures = opts.healFailures ?? formatFailures(first.report.verify);

    opts.onEvent?.("task.healing", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 2,
      session_id: first.report.session_id,
      failures,
    });

    const healPrompt = render(loadTemplate("worker/heal.md"), { failures });

    const healed = await runWithBackoff(healPrompt, { resume: first.report.session_id }, 2);

    if (healed.stopped) return healed.report;

    if (healed.verifyFailed) {
      opts.onEvent?.("task.failed", {
        task_id: opts.taskId,
        generation: opts.generation,
        attempt: 2,
        failure_class: "verify_failed",
      });
    }
    return healed.report;
  }

  opts.onEvent?.("task.failed", {
    task_id: opts.taskId,
    generation: opts.generation,
    attempt,
    failure_class: "verify_failed",
  });
  return first.report;
}
