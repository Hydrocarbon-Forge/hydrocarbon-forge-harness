import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, EngineEvent, PermissionMode, RunId, RunOptions, RunSummary, Settings } from "../../contracts/index.js";
import { createEngine } from "../../engine/engine.js";
import { loadSettings, sandboxProblem, withRequestedRoles } from "../../config/index.js";
import { RunLockError } from "../../store/run-lock.js";
import { createSessionStore, type SessionRecord, type SessionStore } from "../../store/sessions.js";
import { changedFilesOnRun, currentBranchName, runLandedInHead } from "../../git/landing.js";
import {
  MERGE_TURNED_OFF_REASON,
  budgetResumeCommand,
  budgetStopMessage,
  failureOf,
  startBranchOf,
  timeoutResumeCommand,
  timeoutStopMessage,
  verificationOf,
  withLanding,
} from "../../engine/landing.js";
import { planHasIntegrationVerify } from "../../engine/failed-run.js";
import { recordedRunOptions } from "../../engine/recorded-run.js";

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
  verify?: string[];
  request?: string;
  plan?: string;
  work?: string;
  /** Merge a passing run into the checked-out branch, for this run only (R7.4). */
  merge?: boolean;
  /** Keep a finished run on its branch, for this run only (R10.1). */
  noMerge?: boolean;
  /** watch: print the history and exit, without following (R10.2). */
  noFollow?: boolean;
  /** Start the run in the background and return at once (R10.3). */
  detach?: boolean;
  /** Workers that may run at once for this run, 1 to 16 (R10.3). */
  concurrency?: number;
  /** run: plan only and stop for review (R10.5). */
  review?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
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
  signal?: AbortSignal;
  argv?: string[];
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { createFormatter, summaryPayload } = await import(`../output.js`);
const { ProgressLog, runDirOf, writeOutcome } = await import(`../run-files.js`);
const { modelPreflight, repoPreflight, reportPreflightError, writeNotice } = await import(`../preflight.js`);
const { registry } = await import(`../registry.js`);

function splitToolList(values: string | string[] | undefined): string[] {
  const list = Array.isArray(values)
    ? values
    : values !== undefined && values !== null
      ? [values]
      : [];
  const out: string[] = [];
  for (const value of list) {
    let depth = 0;
    let current = "";
    for (const ch of value) {
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth = Math.max(0, depth - 1);
      }
      if (ch === "," && depth === 0) {
        out.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    out.push(current.trim());
  }
  return out.filter((entry) => entry.length > 0);
}

export function buildSettingsOverrides(flags: CommandContext["flags"], mode?: string): Partial<Settings> {
  const overrides: any = {};

  if (flags.model) {
    overrides.roles = overrides.roles || {};
    if (mode === "solo") {
      // --model targets the worker in solo mode (the only role that runs).
      overrides.roles.worker = { model: flags.model };
    } else {
      // plan and auto modes: --model targets the planner only.
      overrides.roles.planner = { model: flags.model };
    }
  }

  if (flags.workerModel) {
    overrides.roles = overrides.roles || {};
    overrides.roles.worker = { model: flags.workerModel };
  }

  if (flags.effort) {
    overrides.roles = overrides.roles || {};
    overrides.roles.planner = overrides.roles.planner || {};
    overrides.roles.planner.effort = flags.effort;
  }

  const allowed = splitToolList(flags.allowedTools);
  const disallowed = splitToolList(flags.disallowedTools);
  if (allowed.length > 0 || disallowed.length > 0) {
    overrides.permissions = overrides.permissions || {};
    if (allowed.length > 0) {
      overrides.permissions.allow = allowed;
    }
    if (disallowed.length > 0) {
      overrides.permissions.deny = disallowed;
    }
  }

  if (flags.maxBudgetUsd !== undefined) {
    overrides.budgets = overrides.budgets || {};
    overrides.budgets.run = overrides.budgets.run || {};
    overrides.budgets.run.max_usd = flags.maxBudgetUsd;
  }

  if (flags.timeout !== undefined) {
    overrides.budgets = overrides.budgets || {};
    overrides.budgets.run = overrides.budgets.run || {};
    // --timeout takes seconds; budgets.run.max_wall_min is in minutes.
    overrides.budgets.run.max_wall_min = flags.timeout / 60;
  }

  if (flags.sandbox) {
    overrides.sandbox = { enabled: true };
  }

  if (flags.concurrency !== undefined) {
    overrides.concurrency = { workers: flags.concurrency };
  }

  return overrides;
}

/** Tracked files with uncommitted changes in the checkout (untracked files do not block a merge). */
function trackedChangesOf(repoRoot: string): string[] {
  const res = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8" });
  return res.status === 0 ? res.stdout.split("\n").filter((line) => line.trim().length > 0) : [];
}

interface LandResult {
  summary: RunSummary;
  exitCode: number;
}

/**
 * The landing choice the caller made (R10.1): --merge or --no-merge on the command line (the
 * flag wins), else the request's merge field, else undefined, so the project setting decides.
 * Both flags together are refused by the caller.
 */
export function mergeChoiceOf(flags: { merge?: boolean; noMerge?: boolean }, requestMerge?: boolean): boolean | undefined {
  if (flags.merge === true) return true;
  if (flags.noMerge === true) return false;
  return requestMerge;
}

/** The --timeout value must be a whole number of seconds, 1 or more (R11.2); undefined when it is not given or is valid. */
export function timeoutFlagProblem(flags: { timeout?: number }): string | undefined {
  if (flags.timeout === undefined) return undefined;
  return Number.isInteger(flags.timeout) && flags.timeout >= 1
    ? undefined
    : "Error: --timeout must be a whole number of seconds, 1 or more\n";
}

/** The --concurrency value must be a whole number from 1 to 16 (R10.3); undefined when it is not given or is valid. */
export function concurrencyFlagProblem(flags: { concurrency?: number }): string | undefined {
  if (flags.concurrency === undefined) return undefined;
  return Number.isInteger(flags.concurrency) && flags.concurrency >= 1 && flags.concurrency <= 16
    ? undefined
    : "Error: --concurrency must be a whole number from 1 to 16\n";
}

/** Refuses --merge with --no-merge, before any side effect (R10.1). */
export function mergeFlagsConflict(flags: { merge?: boolean; noMerge?: boolean }): string | undefined {
  return flags.merge === true && flags.noMerge === true ? "Error: --merge and --no-merge cannot be used together\n" : undefined;
}

// Where a finished run's work lands (R7.4, R10.1). The run is merged into the checked-out branch
// when the caller asked for it or the project setting git.auto_merge says so (default true). It
// lands only when the run finished with every task passed; a failed, paused, interrupted or
// budget-stopped run never lands. The landing refuses, and the run stays finished with the
// reason in not_merged_reason, when the work would land on another branch than the run started
// on, when the checkout has uncommitted tracked changes, or when the changes conflict. The changed
// files are read before any merge, since the merge moves the fork point.
export async function landRun(
  ctx: CommandContext,
  summary: RunSummary,
  opts: { mergeRequested: boolean; events: EngineEvent[] },
): Promise<LandResult> {
  const runFailed = summary.exit_code !== 0;
  const base_branch = currentBranchName(ctx.cwd);
  // No branch, no files: a run that never created its branch changed nothing to land (R7.9).
  const files = summary.branch === undefined ? [] : changedFilesOnRun(ctx.cwd, summary.branch);
  let exitCode = summary.exit_code;
  // R8.2: a refused landing leaves a finished run, not a failed one. R10.1: the same holds for every
  // refusal below, and each one names its reason and the command that lands the run later.
  let notMergedReason: string | undefined;
  const allPassed = Object.values(summary.tasks ?? {}).every((t) => t.state === "PASSED");
  if (!runFailed && summary.status === "finished" && allPassed && summary.branch !== undefined) {
    if (!opts.mergeRequested) {
      notMergedReason = MERGE_TURNED_OFF_REASON;
    } else {
      const started = startBranchOf(opts.events);
      if (started === "HEAD") {
        notMergedReason = `not merged: the run started on a detached HEAD, so it has no branch to land on; check out a branch and run: substrate merge ${summary.run_id}`;
        exitCode = 1;
      } else if (started !== undefined && started !== base_branch) {
        // R10.1: the work lands on the branch the run started on, and only while that branch is checked out.
        notMergedReason = `not merged: you switched from ${started} to ${base_branch} while the run was working; check out ${started} and run: substrate merge ${summary.run_id}`;
        exitCode = 1;
      } else {
        const dirty = trackedChangesOf(ctx.cwd);
        if (dirty.length > 0) {
          notMergedReason = `not merged: your working tree has uncommitted changes; commit or stash them, then run: substrate merge ${summary.run_id}`;
          exitCode = 1;
        } else {
          const { mergeRun } = await import(`./merge.js`);
          const conflicts: string[][] = [];
          let mergeCode: number;
          try {
            mergeCode = await mergeRun(ctx, summary.run_id, {
              dryRun: false,
              abortOnConflict: false,
              quiet: true,
              onConflict: (names) => conflicts.push(names),
            });
          } catch (err: any) {
            mergeCode = 1;
            notMergedReason = `not merged: ${err?.message ?? "the merge failed"}; run: substrate merge ${summary.run_id}`;
          }
          if (mergeCode !== 0) {
            exitCode = mergeCode;
            if (conflicts.length > 0) {
              notMergedReason = `not merged: the run's changes conflict with your branch in ${conflicts[0].join(", ")}; resolve them, then run: substrate merge ${summary.run_id}`;
            } else if (notMergedReason === undefined) {
              notMergedReason = `not merged: the merge into ${base_branch} failed; run: substrate merge ${summary.run_id}`;
            }
          }
        }
      }
    }
  }
  // A failed run never lands, even when its branch has no commits of its own.
  const merged = !runFailed && summary.branch !== undefined && runLandedInHead(ctx.cwd, summary.branch);
  let failure = runFailed ? failureOf(opts.events) : undefined;
  let resumeCommand: string | undefined;
  // R8.2: a run stopped by its run budget says what it spent, what each task was doing, and the
  // resume command with a higher budget.
  if (summary.pause_reason === "budget_exhausted") {
    const exceeded = [...opts.events].reverse().find((e) => e.type === "run.budget.exceeded");
    const spent = Number((exceeded?.data as { cost_usd?: unknown } | undefined)?.cost_usd ?? summary.usage?.total_usd ?? 0);
    // R11.1: the cap the run recorded (its run.created, or the resume that replaced it), before the flag.
    const cap = Number(
      (exceeded?.data as { max_usd?: unknown } | undefined)?.max_usd ??
        recordedRunOptions(opts.events).max_budget_usd ??
        ctx.flags.maxBudgetUsd ??
        0,
    );
    failure = {
      failure_class: "budget_exhausted",
      message: budgetStopMessage(spent, cap, summary.tasks),
    };
    resumeCommand = budgetResumeCommand(summary.run_id, spent, cap);
  }
  // R11.2: a run stopped by its wall-clock limit says the limit, what each task was doing, and the resume with
  // a longer --timeout. The limit is the one the run paused with, else the one it recorded.
  if (summary.pause_reason === "timeout") {
    const paused = [...opts.events].reverse().find((e) => e.type === "run.paused" && (e.data as { reason?: unknown } | undefined)?.reason === "timeout");
    const limit = Number(
      (paused?.data as { time_limit_s?: unknown } | undefined)?.time_limit_s ??
        recordedRunOptions(opts.events).time_limit_s ??
        0,
    );
    failure = { failure_class: "timeout", message: timeoutStopMessage(limit, summary.tasks) };
    resumeCommand = timeoutResumeCommand(summary.run_id, limit);
  }
  // The final check's outcome (R12.2): passed, failed, skipped, or not run with its reason.
  const verification = verificationOf(opts.events);
  const landed = withLanding(
    { ...summary, exit_code: exitCode },
    {
      merged,
      base_branch,
      files,
      runFailed,
      needsInput: summary.pause_reason === "needs_human" && summary.questions !== undefined,
      ...(failure !== undefined ? { failure } : {}),
      ...(resumeCommand !== undefined ? { resumeCommand } : {}),
      ...(notMergedReason !== undefined ? { notMergedReason } : {}),
      ...(verification !== undefined ? { verification } : {}),
      // A task merged into the run branch is what `merge --partial` lands (R8.2).
      partialLandable: summary.status === "failed" && summary.branch !== undefined &&
        opts.events.some((e) => e.type === "task.merged") &&
        planHasIntegrationVerify(path.join(ctx.cwd, ".substrate", "runs", summary.run_id)),
    },
  );
  return { summary: landed, exitCode };
}

export const runCommand: CliCommand = {
  name: "run",
  description: "Execute Substrate run with specified prompt",
  async execute(ctx: CommandContext): Promise<number> {
    const concurrencyProblem = concurrencyFlagProblem(ctx.flags);
    if (concurrencyProblem !== undefined) {
      ctx.stderr.write(concurrencyProblem);
      return 2;
    }
    const timeoutProblem = timeoutFlagProblem(ctx.flags);
    if (timeoutProblem !== undefined) {
      ctx.stderr.write(timeoutProblem);
      return 2;
    }
    // R10.5: --review is plan only. It is the plan command's path, and it records the worker, so a bare resume works.
    if (ctx.flags.review === true) {
      if (ctx.flags.work === undefined) {
        ctx.stderr.write("Error: --review needs --work <provider:model[:effort]>\n");
        return 2;
      }
      const { planCommand } = await import(`./plan.js`);
      return planCommand.execute(ctx as any);
    }
    // R10.3: a detached run is started by a child of this CLI, which then runs the same code.
    if (ctx.flags.detach === true) {
      const { detachFrom } = await import(`../detach.js`);
      return detachFrom(ctx);
    }
    if (ctx.flags.resume) {
      const { resumeCommand } = await import(`./resume.js`);
      return resumeCommand.execute({ ...ctx, rawArgs: [ctx.flags.resume] });
    } else if (ctx.flags.continue) {
      const store =
        ctx.sessionStore ??
        createSessionStore(path.join(ctx.cwd, ".substrate"));
      const latest = await store.getLatest();
      if (!latest) {
        ctx.stderr.write("Error: no session to continue\n");
        return 2;
      }
      const { resumeCommand } = await import(`./resume.js`);
      return resumeCommand.execute({ ...ctx, rawArgs: [latest.sessionId] });
    } else if (ctx.flags.forkSession) {
      ctx.stderr.write("Error: --fork-session requires --resume or --continue\n");
      return 2;
    }

    // Refuse before any side effect: the caller must name the models this mode needs.
    // The request is validated next; only then may the project become a git repository.
    const modelCheck = modelPreflight("run", { cwd: ctx.cwd, flags: ctx.flags, stdin: ctx.stdin });
    if (!modelCheck.ok) {
      reportPreflightError(ctx, modelCheck);
      return 2;
    }

    let mode = ctx.flags.mode ?? "auto";
    let permission_mode = ctx.flags.permissionMode ?? "dontAsk";
    // --merge, --no-merge or the request's merge field decide this run's landing (R7.4, R10.1).
    const mergeConflict = mergeFlagsConflict(ctx.flags);
    if (mergeConflict !== undefined) {
      ctx.stderr.write(mergeConflict);
      return 2;
    }
    let requestMerge: boolean | undefined;
    let overrides = buildSettingsOverrides(ctx.flags, mode);
    let prompt = ctx.rawArgs[0];
    let runVerify: string[] | undefined;
    let runContext: string[] | undefined;

    if (ctx.flags.request !== undefined || ctx.flags.plan !== undefined || ctx.flags.work !== undefined) {
      const { loadRequest } = await import(`../request.js`);
      const reqRes = await loadRequest(ctx.flags.request, ctx.stdin, ctx.flags, {
        repoRoot: ctx.cwd,
        rawPrompt: ctx.rawArgs[0],
      });
      if (!reqRes.ok) {
        ctx.stdout.write(JSON.stringify({ error: "invalid_request", problems: reqRes.problems }) + "\n");
        return 2;
      }
      prompt = reqRes.request.goal;
      if (reqRes.request.mode) {
        mode = reqRes.request.mode;
      }
      if (reqRes.request.permission_mode) {
        permission_mode = reqRes.request.permission_mode;
      }
      requestMerge = reqRes.request.merge;
      if (reqRes.overrides.roles) {
        overrides.roles = { ...(overrides.roles ?? {}), ...reqRes.overrides.roles };
      }
      if (reqRes.overrides.budgets) {
        overrides.budgets = { ...(overrides.budgets ?? {}), ...reqRes.overrides.budgets };
      }
      if (reqRes.overrides.verify) {
        runVerify = reqRes.overrides.verify;
      }
      if (reqRes.overrides.context) {
        runContext = reqRes.overrides.context;
      }
    } else {
      if (!prompt && ctx.stdin && ctx.stdin.trim().length > 0) {
        prompt = ctx.stdin.trim();
      }
      if (!prompt || !prompt.trim()) {
        ctx.stderr.write("Error: prompt required on command line or stdin\n");
        return 2;
      }
      prompt = prompt.trim();
    }

    // The request is valid. Now the project directory may be initialised (an empty one
    // gets its base commit); a directory that is not a repository is refused here.
    const repo = repoPreflight(ctx.cwd);
    if (!repo.ok) {
      reportPreflightError(ctx, repo);
      return 2;
    }
    if (repo.notice) {
      writeNotice(ctx, repo.notice);
    }

    // The models named by the request or the flags take precedence over every other route (R7.4).
    overrides = withRequestedRoles(overrides);

    // Solo runs with no verify command get a warning. An explicit solo run warns now;
    // an auto run warns when the engine's route action routes it to solo (run.routed).
    const verifyFlagsForWarning = runVerify ?? ctx.flags.verify;
    let warnNoVerify = false;
    if ((mode === "solo" || mode === "auto") && (!verifyFlagsForWarning || verifyFlagsForWarning.length === 0)) {
      const { detectEcosystem, getDefaultVerify } = await import(`../../spec/ecosystem.js`);
      const eco = await detectEcosystem(ctx.cwd);
      warnNoVerify = getDefaultVerify(eco).length === 0;
    }
    if (mode === "solo" && warnNoVerify) {
      ctx.stderr.write("warning: no verify commands; only scope and budget checks apply\n");
    }

    const sessionStore =
      ctx.sessionStore ??
      createSessionStore(path.join(ctx.cwd, ".substrate"));

    let session: SessionRecord | null = null;
    if (ctx.flags.sessionId) {
      session = await sessionStore.get(ctx.flags.sessionId);
      if (!session) {
        session = await sessionStore.create({ mode, prompt });
      }
    } else if (ctx.flags.continue) {
      session = await sessionStore.getLatest();
      if (!session) {
        ctx.stderr.write("No prior session found in this directory\n");
        return 2;
      }
    } else {
      session = await sessionStore.create({ mode, prompt });
    }

    let engine = ctx.engine;
    let loadedSettings: Settings | undefined;
    if (!engine) {
      try {
        const settings = await loadSettings({
          projectDir: ctx.cwd,
          settingsFile: ctx.flags.settings,
          flags: overrides,
        });
        loadedSettings = settings;
        const problem = sandboxProblem(settings);
        if (problem) {
          ctx.stderr.write(`Error: ${problem}\n`);
          return 2;
        }
        engine = createEngine({ settings });
      } catch (err: any) {
        ctx.stderr.write(`Error loading settings: ${err.message}\n`);
        return 2;
      }
    }

    // The formatter is built after settings load so the start line can name the models.
    const { progressModelsFor } = await import(`../progress.js`);
    // R10.2: the progress log opens when the run is created, and takes every progress line.
    let progressLog: InstanceType<typeof ProgressLog> | undefined;
    const formatter = createFormatter(
      ctx.flags.outputFormat ?? "text",
      ctx.stdout,
      ctx.stderr,
      {
        ...(loadedSettings ? { models: progressModelsFor(loadedSettings) } : {}),
        log: (text) => progressLog?.append(text),
      },
    );

    const runEvents: EngineEvent[] = [];
    const runOpts: RunOptions = {
      cwd: ctx.cwd,
      mode,
      permission_mode,
      // R10.1/R10.3: the landing the caller chose; the engine records the effective one on run.created.
      ...(mergeChoiceOf(ctx.flags, requestMerge) !== undefined ? { merge: mergeChoiceOf(ctx.flags, requestMerge) } : {}),
      prompt,
      overrides,
      signal: ctx.signal,
      onEvent: (event) => {
        if (mode === "auto" && warnNoVerify && event.type === "run.routed" && (event.data as { mode?: unknown }).mode === "solo") {
          ctx.stderr.write("warning: no verify commands; only scope and budget checks apply\n");
        }
        if (event.type === "run.created") {
          progressLog = new ProgressLog(runDirOf(ctx.cwd, event.run_id), (m) => ctx.stderr.write(m));
          progressLog.header(`run ${event.run_id} started ${new Date().toISOString()}`);
        }
        runEvents.push(event);
        formatter.onEvent(event);
      },
    };
    const verifyCmds = runVerify ?? ctx.flags.verify;
    if (verifyCmds) {
      (runOpts.overrides as any).verify = verifyCmds;
    }
    if (runContext) {
      (runOpts.overrides as any).context = runContext;
    }

    try {
      const summary = await engine.run(runOpts);
      if (summary.pause_reason === "needs_human" && summary.questions === undefined) {
        const qPath = path.join(ctx.cwd, ".substrate", "runs", summary.run_id, "QUESTIONS.md");
        if (fs.existsSync(qPath)) {
          const { parseQuestions } = await import(`../questions.js`);
          summary.questions = parseQuestions(fs.readFileSync(qPath, "utf8"));
        }
      }
      if (sessionStore && session) {
        await sessionStore.addRun(session.sessionId, summary.run_id, prompt);
      }
      const effectiveSettings =
        loadedSettings ??
        (await loadSettings({
          projectDir: ctx.cwd,
          settingsFile: ctx.flags.settings,
          flags: overrides,
        }));
      const landed = await landRun(ctx, summary, {
        mergeRequested: mergeChoiceOf(ctx.flags, requestMerge) ?? effectiveSettings.git?.auto_merge === true,
        events: runEvents,
      });
      formatter.onSummary(landed.summary, session?.sessionId ?? "");
      await formatter.flush();
      // R10.2: the outcome is kept in the run directory, whatever state the run ended in.
      writeOutcome(
        runDirOf(ctx.cwd, landed.summary.run_id),
        formatter.renderedSummary() ?? "",
        summaryPayload(landed.summary, session?.sessionId ?? "", runEvents),
      );
      return landed.exitCode;
    } catch (err: any) {
      if (err instanceof RunLockError) {
        formatter.onError(err);
        await formatter.flush();
        return 2;
      }
      if (err.name === "AbortError" || err.message?.includes("SIGINT")) {
        return 130;
      }
      if (err.message?.includes("SIGTERM")) {
        return 143;
      }
      formatter.onError(err);
      await formatter.flush();
      return 1;
    }
  },
};

registry.register(runCommand);
