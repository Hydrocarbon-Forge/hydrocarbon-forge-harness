import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPAIR_ATTEMPTS_DEFAULT } from "../../contracts/index.js";
import type { Command, Manifest, Settings, TaskId, WorkerReport } from "../../contracts/index.js";
import type { EffectContext } from "../effects.js";
import { checkRunBudget, interruptOf } from "../effects.js";
import type { EngineState } from "../reducer.js";
import type { Emit } from "./shared.js";
import { adapterFor, integrationFailureDetail } from "./shared.js";
import { classifyVerifyFailure } from "../verify-outcome.js";
import { checkRepairDiff, readRepairDiff } from "../repair-guard.js";
import { parseTaskSpec } from "../../spec/index.js";
import { EventStoreImpl } from "../../store/event-store.js";
import { loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";
import { resolveTaskRoute } from "../../roles/router.js";
import { repairSpecOf, runRepairWorker } from "../../roles/worker.js";
import type { WorkerRunPolicy } from "../../roles/worker.js";
import {
  advanceRunRef,
  mergeInto,
  setUpWorktree,
  verifyIn,
  workspaceManager,
  type VerifyFailure,
} from "../../git/index.js";
import { withRepoLock } from "../../git/repo-lock.js";
import { takeTail } from "../../util/index.js";

// Repair of a failed final check (R12.4). The final integration verify failed for a real reason: a
// repair worker gets the check's output and the run's merged tasks, and edits the code in a worktree
// off the integration HEAD. The guard (repair-guard.ts) rejects an attempt that loosens the check. An
// attempt that passes is merged into the integration branch, and the final check runs again there.
// Repairs run inside the integration action, one at a time, so nothing else of the run is in flight.

/** The task class a repair runs as: the debugging addendum, routed like any other class (R3.4). */
export const REPAIR_TASK_CLASS = "debug";

/** How many lines of the check's output the repair prompt carries (the last ones). */
const REPAIR_TAIL_LINES = 60;

/** The commands of the final check: the plan's setup, and its integration_verify. */
export interface RepairChecks {
  setup: Command[];
  verify: Command[];
}

/** One repair attempt's outcome: passed, rejected with a reason (and the output it saw, if a check ran), or stopped. */
type AttemptResult =
  | { kind: "passed" }
  | { kind: "rejected"; reason: string; failure?: VerifyFailure; unfixable?: boolean }
  | { kind: "stopped" };

/** The outcome of the whole repair loop for one failed final check. */
export type RepairResult =
  | { status: "passed"; attempts: number }
  | { status: "failed"; attempts: number; reason: string; failure: VerifyFailure }
  | { status: "stopped" };

/** The number of repair attempts the settings allow (0 turns repair off). */
export function repairAttemptsOf(settings: Settings): number {
  return settings.integration?.repair_attempts ?? REPAIR_ATTEMPTS_DEFAULT;
}

/** The synthetic task id of one attempt: REPAIR-<attempt>. */
export function repairTaskId(attempt: number): TaskId {
  return `REPAIR-${attempt}`;
}

/** The repair round: 1 for the first failed check of the run, one more for each later one (a resume, a replan). */
function repairRoundOf(ctx: EffectContext): number {
  const store = ctx.store ?? new EventStoreImpl(ctx.runId, { runDir: ctx.runDir });
  const starts = store.readAllSync().filter(
    (e) => e.type === "integration.repair.started" && (e.data as { attempt?: unknown }).attempt === 1,
  );
  return starts.length + 1;
}

/** The run's request as recorded on run.created; empty when the run recorded none. */
function requestOf(ctx: EffectContext): string {
  const store = ctx.store ?? new EventStoreImpl(ctx.runId, { runDir: ctx.runDir });
  const created = store.readAllSync().find((e) => e.type === "run.created");
  const prompt = (created?.data as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

/** One line per merged task: its id and title, read from its spec (the id alone when the spec cannot be read). */
function mergedTasksText(ctx: EffectContext, state: EngineState, manifest: Manifest | undefined): string {
  const lines: string[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.state !== "MERGED") continue;
    const specRel = manifest?.tasks.find((t) => t.id === task.id)?.spec ?? `tasks/${task.id}.md`;
    let title = "";
    try {
      const specPath = join(ctx.runDir, specRel);
      title = parseTaskSpec(readFileSync(specPath, "utf8"), specPath).frontmatter.title;
    } catch {
      title = "";
    }
    lines.push(title ? `${task.id}: ${title}` : task.id);
  }
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

/** The last lines of a check's output, as the repair prompt carries them. */
function tailLines(text: string): string {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  return lines.slice(-REPAIR_TAIL_LINES).join("\n");
}

/** The git head of a worktree. */
function headOf(worktreePath: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
}

/** The worker's run policy during a repair: the run's budget, a denied permission, a rate limit, a budget stop. */
function repairPolicy(ctx: EffectContext, emit: Emit, runSpend: () => number, runTokens: () => number): WorkerRunPolicy {
  return (obs) => {
    if (checkRunBudget(ctx, emit, runSpend(), runTokens())) {
      return { stop: true, kill: "budget" };
    }
    if (obs.event?.type === "permission.denied") {
      emit("run.paused", { reason: "permission_denied" });
      return { stop: true, kill: "cancel" };
    }
    if (obs.event?.type === "error" && obs.event.kind === "rate_limit") {
      emit("run.paused", { reason: "rate_limited" });
      return { stop: true, kill: "cancel" };
    }
    const res = obs.result;
    if (res) {
      if (res.killed_for === "budget") {
        emit("run.budget.exceeded", { cost_usd: runSpend(), max_usd: ctx.settings.budgets.run.max_usd ?? 0 });
        emit("run.paused", { reason: "budget_exhausted" });
        return { stop: true };
      }
      if (res.denials && res.denials.length > 0) {
        emit("run.paused", { reason: "permission_denied" });
        return { stop: true };
      }
      if (res.killed_for === "cancel") {
        return { stop: true };
      }
    }
    return { stop: false };
  };
}

/**
 * The worker's own final line, when it reports that the check cannot be fixed by editing code here
 * (CHECK-UNFIXABLE: <reason>). Undefined when it does not.
 */
function unfixableReasonOf(report: WorkerReport): string | undefined {
  const match = report.final_message.match(/^CHECK-UNFIXABLE:\s*(.*)$/m);
  if (!match) return undefined;
  return match[1].trim() || "the worker reported the check cannot be fixed by editing code";
}

/**
 * One attempt (R12.4): a worktree off the integration HEAD, set up with the plan's setup; the worker; the
 * anti-cheat guard on what it committed; the integration command in the repair worktree; a merge into the
 * integration branch, which advances the run branch; and the integration command again in the integration
 * worktree. Only a re-run that passes makes the attempt passed.
 */
async function runOneAttempt(args: {
  ctx: EffectContext;
  state: EngineState;
  emit: Emit;
  checks: RepairChecks;
  integrationWorktree: string;
  attempt: number;
  max: number;
  round: number;
  lastFailure: VerifyFailure;
  previous: string;
  manifest: Manifest | undefined;
  roots: string[];
}): Promise<AttemptResult> {
  const { ctx, emit, checks, integrationWorktree, attempt, round } = args;
  const taskId = repairTaskId(attempt);
  const baseSha = headOf(integrationWorktree);
  const taskClass = REPAIR_TASK_CLASS;
  const route = resolveTaskRoute(taskClass, attempt, ctx.settings);
  const adapter = adapterFor(ctx, route.backend);
  if (!adapter) {
    emit("run.paused", { reason: "backend_unavailable" });
    return { kind: "stopped" };
  }

  const worktree = await withRepoLock(ctx.repoRoot, () =>
    workspaceManager.createTaskWorktree(ctx.repoRoot, ctx.runId, repairSpecOf(taskId, taskClass), round, baseSha),
  );

  const setup = await setUpWorktree(worktree.worktreePath, checks.setup);
  if (setup !== undefined && !setup.passed) {
    return { kind: "rejected", reason: `the setup failed in the repair worktree (${setup.failure.command})` };
  }

  const detail = integrationFailureDetail(args.lastFailure, args.roots);
  const promptText = render(loadTemplate("worker/repair.md"), {
    attempt: String(attempt),
    max_attempts: String(args.max),
    request: requestOf(ctx),
    check_command: checks.verify.map((c) => c.run).join("\n"),
    output_tail: tailLines(detail.output_tail),
    tasks: mergedTasksText(ctx, args.state, args.manifest),
    previous: args.previous,
  });

  const runSpend = (): number => ctx.journal?.state.usage.total_usd ?? args.state.usage.total_usd;
  const runTokens = (): number => ctx.journal?.tokens ?? 0;
  const repaired = await runRepairWorker({
    runId: ctx.runId,
    repoRoot: ctx.repoRoot,
    settings: ctx.settings,
    adapter,
    taskId,
    generation: round,
    attempt,
    taskClass,
    worktreePath: worktree.worktreePath,
    baseRef: baseSha,
    rawDir: ctx.runDir,
    promptText,
    signal: interruptOf(ctx),
    runPolicy: repairPolicy(ctx, emit, runSpend, runTokens),
    // Only the usage of the repair session is the run's; the task events of the worker stay out of the log,
    // so the reducer keeps the repair rows apart from the plan's tasks. The return value is never read.
    onEvent: (type, data) => {
      if (type === "usage.recorded") emit(type, data);
    },
  });
  if (repaired.stopped || interruptOf(ctx)?.aborted) return { kind: "stopped" };

  const report = repaired.report;
  const unfixable = unfixableReasonOf(report);
  if (unfixable !== undefined) {
    return { kind: "rejected", reason: `CHECK-UNFIXABLE: ${unfixable}`, unfixable: true };
  }
  if (report.status !== "passed") {
    return { kind: "rejected", reason: `the repair worker failed (${report.failure_class ?? "no result"})` };
  }

  // The anti-cheat guard: what the attempt committed, against the integration HEAD it started from.
  const head = headOf(worktree.worktreePath);
  const verdict = checkRepairDiff(readRepairDiff(worktree.worktreePath, baseSha, head));
  if (!verdict.ok) {
    return { kind: "rejected", reason: verdict.reason };
  }

  // The check in the repair worktree. A failure here means the repair did not fix the check.
  const own = await verifyIn(worktree.worktreePath, checks.verify, ctx.settings);
  if (!own.passed) {
    return { kind: "rejected", reason: "the integration check still fails in the repair worktree", failure: own.failure };
  }

  // Merge the repair into the integration branch and advance the run branch to it (as a task merge does).
  try {
    await withRepoLock(ctx.repoRoot, async () => {
      const merged = await mergeInto(integrationWorktree, worktree.branch, `repair: integration check (attempt ${attempt})`);
      await advanceRunRef(ctx.repoRoot, ctx.runId, merged, baseSha);
    });
  } catch {
    try {
      execFileSync("git", ["merge", "--abort"], { cwd: integrationWorktree, stdio: "ignore" });
    } catch {}
    return { kind: "rejected", reason: "the repair does not merge cleanly into the run branch" };
  }

  // The final check again, in the integration worktree (its setup is already done there).
  const after = await verifyIn(integrationWorktree, checks.verify, ctx.settings);
  if (after.passed) return { kind: "passed" };
  const verdictAfter = classifyVerifyFailure(after.failure);
  if (verdictAfter.verdict === "could_not_run") {
    return {
      kind: "rejected",
      reason: `the integration check could not run after the repair (${verdictAfter.reason})`,
      failure: after.failure,
    };
  }
  return { kind: "rejected", reason: "the integration check still fails after the repair was merged", failure: after.failure };
}

/**
 * The repair loop for a failed final check (R12.4). Up to `settings.integration.repair_attempts` attempts,
 * each announced by integration.repair.started and closed by integration.repair.finished. A passed attempt
 * ends the loop; a CHECK-UNFIXABLE worker ends it at once. The result carries the last failure, so the
 * caller reports the output the last re-run saw.
 */
export async function repairIntegration(args: {
  ctx: EffectContext;
  state: EngineState;
  emit: Emit;
  checks: RepairChecks;
  integrationWorktree: string;
  failure: VerifyFailure;
  manifest: Manifest | undefined;
  roots: string[];
}): Promise<RepairResult> {
  const { ctx, emit } = args;
  const max = repairAttemptsOf(ctx.settings);
  const round = repairRoundOf(ctx);
  let lastFailure = args.failure;
  let previous = "(none)";
  let attempts = 0;
  let reason = "";

  for (let attempt = 1; attempt <= max; attempt++) {
    if (interruptOf(ctx)?.aborted) return { status: "stopped" };
    attempts = attempt;
    const taskId = repairTaskId(attempt);
    emit("integration.repair.started", { task_id: taskId, attempt, max });
    const result = await runOneAttempt({
      ...args,
      attempt,
      max,
      round,
      lastFailure,
      previous,
    });
    if (result.kind === "stopped") return { status: "stopped" };
    if (result.kind === "passed") {
      emit("integration.repair.finished", { task_id: taskId, attempt, passed: true });
      return { status: "passed", attempts: attempt };
    }
    reason = result.reason;
    emit("integration.repair.finished", { task_id: taskId, attempt, passed: false, reason: takeTail(reason, 500).text });
    if (result.failure !== undefined) lastFailure = result.failure;
    previous = `attempt ${attempt} was rejected: ${reason}`;
    if (result.unfixable) break;
  }
  return { status: "failed", attempts, reason, failure: lastFailure };
}
