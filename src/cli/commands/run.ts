import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, EngineEvent, PermissionMode, RunId, RunOptions, RunSummary, Settings } from "../../contracts/index.js";
import { createEngine } from "../../engine/engine.js";
import { loadSettings, sandboxProblem, withRequestedRoles } from "../../config/index.js";
import { RunLockError } from "../../store/run-lock.js";
import { createSessionStore, type SessionRecord, type SessionStore } from "../../store/sessions.js";
import { changedFilesOnRun, currentBranchName, runLandedInHead } from "../../git/landing.js";
import { failureOf, withLanding } from "../../engine/landing.js";

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
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { createFormatter } = await import(`../output.js`);
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

  return overrides;
}

interface LandResult {
  summary: RunSummary;
  exitCode: number;
}

// Where a finished run's work lands (R7.4). The changed files are read before any merge, since
// the merge moves the fork point. The run is merged into the checked-out branch only when the
// caller asked (--merge, the request's merge field, or git.auto_merge); otherwise the run branch
// stays for `substrate merge`. A failed merge sets the exit code to the merge's.
async function landRun(
  ctx: CommandContext,
  summary: RunSummary,
  opts: { mergeRequested: boolean; events: EngineEvent[] },
): Promise<LandResult> {
  const runFailed = summary.exit_code !== 0;
  const base_branch = currentBranchName(ctx.cwd);
  // No branch, no files: a run that never created its branch changed nothing to land (R7.9).
  const files = summary.branch === undefined ? [] : changedFilesOnRun(ctx.cwd, summary.branch);
  let exitCode = summary.exit_code;
  if (!runFailed && opts.mergeRequested) {
    const { mergeRun } = await import(`./merge.js`);
    const mergeCode = await mergeRun(ctx, summary.run_id, { dryRun: false, abortOnConflict: false, quiet: true });
    if (mergeCode !== 0) {
      exitCode = mergeCode;
    }
  }
  // A failed run never lands, even when its branch has no commits of its own.
  const merged = !runFailed && summary.branch !== undefined && runLandedInHead(ctx.cwd, summary.branch);
  const failure = runFailed ? failureOf(opts.events) : undefined;
  const landed = withLanding(
    { ...summary, exit_code: exitCode },
    {
      merged,
      base_branch,
      files,
      runFailed,
      needsInput: summary.pause_reason === "needs_human" && summary.questions !== undefined,
      ...(failure !== undefined ? { failure } : {}),
    },
  );
  return { summary: landed, exitCode };
}

export const runCommand: CliCommand = {
  name: "run",
  description: "Execute Substrate run with specified prompt",
  async execute(ctx: CommandContext): Promise<number> {
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
    // --merge or the request's merge field: merge a passing run for this run only (R7.4).
    let mergeFlag = ctx.flags.merge === true;
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
      if (reqRes.request.merge === true) {
        mergeFlag = true;
      }
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
    const formatter = createFormatter(
      ctx.flags.outputFormat ?? "text",
      ctx.stdout,
      ctx.stderr,
      {
        ...(loadedSettings ? { models: progressModelsFor(loadedSettings) } : {}),
      },
    );

    const runEvents: EngineEvent[] = [];
    const runOpts: RunOptions = {
      cwd: ctx.cwd,
      mode,
      permission_mode,
      prompt,
      overrides,
      signal: ctx.signal,
      onEvent: (event) => {
        if (mode === "auto" && warnNoVerify && event.type === "run.routed" && (event.data as { mode?: unknown }).mode === "solo") {
          ctx.stderr.write("warning: no verify commands; only scope and budget checks apply\n");
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
        mergeRequested: mergeFlag || effectiveSettings.git?.auto_merge === true,
        events: runEvents,
      });
      formatter.onSummary(landed.summary, session?.sessionId ?? "");
      await formatter.flush();
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
