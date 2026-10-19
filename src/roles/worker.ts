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

/** The action's typed emit (R1.2): every event is checked against the catalog. */
export type WorkerEmit = <T extends EventType>(
  type: T,
  data: EventData<T>
) => EngineEvent;

export type WorkerKillReason = "budget" | "timeout" | "cancel";

/**
 * What the worker observed: a streamed event with the usage delta computed for it,
 * or the session result once the stream is drained.
 */
export type WorkerObservation = {
  event?: BackendEvent;
  usageDelta?: UsageRecord;
  result?: SessionResult;
};

/**
 * Run-level policy is the engine action's decision, not the role's (R1.4, R1.5).
 * The worker reports what it observed and the action answers whether this attempt
 * must stop and with which kill reason. The role never decides run policy.
 */
export type WorkerRunPolicy = (
  observation: WorkerObservation
) => { stop: boolean; kill?: WorkerKillReason };

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
}

/** Cap for one command's failure output in the heal prompt (R1.6). */
const FAILURE_TAIL_CAP = 8192;

/** One L0 heal per generation. Which failure escalates is the engine ladder (R3.4). */
const HEAL_CAP = 1;

function gitRef(worktreePath: string, args: string[]): string {
  return execFileSync("git", ["-C", worktreePath, ...args], {
    encoding: "utf8",
  }).trim();
}

function formatFailures(results: VerifyResult[]): string {
  return results
    .filter((r) => r.exit_code !== 0 || r.timed_out)
    .map((r) => {
      const parts = [`Command: ${r.cmd}`, `Exit code: ${r.exit_code}`];
      if (r.stdout_tail) parts.push(`Stdout:\n${r.stdout_tail.slice(0, FAILURE_TAIL_CAP)}`);
      if (r.stderr_tail) parts.push(`Stderr:\n${r.stderr_tail.slice(0, FAILURE_TAIL_CAP)}`);
      return parts.join("\n");
    })
    .join("\n\n");
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
}

type StopDecision = { stop: boolean; kill?: WorkerKillReason };

class AttemptStopped extends Error {
  constructor(public readonly decision: StopDecision) {
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
  usage: UsageRecord
): Promise<AttemptOutcome> {
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
      timeout_ms:
        (opts.spec.budget?.timeout_min ?? opts.settings.budgets.task.timeout_min ?? 30) *
        60 *
        1000,
      ...(opts.spec.budget?.max_tokens ? { max_tokens: opts.spec.budget.max_tokens } : {}),
    },
  };

  const handle = opts.adapter.spawn(spawnReq);

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

  let unbind = () => {};
  if (opts.signal) {
    if (opts.signal.aborted) {
      await handle.kill("cancel");
    } else {
      const onAbort = () => {
        void handle.kill("cancel");
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      unbind = () => opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  try {
    for await (const event of handle.events) {
      if (event.type === "session.started" && event.session_id) {
        sessionId = event.session_id;
        recordSessionStarted();
      }

      let delta: UsageRecord | undefined;
      if (event.type === "usage" && event.record) {
        sawUsage = true;
        delta = recordUsage(event.record, Boolean(event.cumulative));
      }

      const decision = opts.runPolicy?.({ event, usageDelta: delta });
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

    const decision = opts.runPolicy?.({ result: res, usageDelta: resultDelta });
    if (decision?.stop) throw new AttemptStopped(decision);

    if (!sessionId) return fail("worker_crashed", "adapter reported no session id");

    if (res.killed_for === "timeout") {
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
      opts.onEvent?.("task.failed", {
        task_id: opts.taskId,
        generation: opts.generation,
        attempt,
        failure_class: "protected_modified",
        can_replan: false,
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
    const passed = runner.isAllPassed(verifyResults);

    opts.onEvent?.("task.verify.finished", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt,
      passed,
      failure_class: passed ? undefined : "verify_failed",
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
      return {
        report: buildReport("failed", undefined),
        stopped: true,
        verifyFailed: false,
      };
    }
    throw err;
  } finally {
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

  const taskPrompt = render(loadTemplate("worker/task.md"), {
    spec_path: baseline.specPath,
  });

  const first = await runAttempt(
    opts,
    route,
    attempt,
    taskPrompt,
    opts.session ?? { id: crypto.randomUUID() },
    baseline,
    startTime,
    sessionTotals,
    usage
  );

  if (first.stopped) return first.report;

  if (!first.verifyFailed) return first.report;

  // The one L0 heal per generation resumes the same session in the same worktree
  // with the heal template rendered from real verify output. Escalation is the
  // engine ladder (R3.4), so here the first failure gets that one heal.
  if (attempt === 1) {
    opts.onEvent?.("task.healing", {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 2,
      session_id: first.report.session_id,
    });

    const healPrompt = render(loadTemplate("worker/heal.md"), {
      failures: opts.healFailures ?? formatFailures(first.report.verify),
    });

    const healed = await runAttempt(
      opts,
      route,
      2,
      healPrompt,
      { resume: first.report.session_id },
      baseline,
      startTime,
      sessionTotals,
      usage
    );

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
