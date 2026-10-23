import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, EngineEvent, PermissionMode, Question, RunId, RunOptions } from "../../contracts/index.js";
import { createEngine } from "../../engine/engine.js";
import { loadSettings, sandboxProblem } from "../../config/index.js";
import { RunLockError } from "../../store/run-lock.js";
import { deepMerge } from "../../util/merge.js";
import { recordedRunOptions, recordedSettingsOverrides } from "../../engine/recorded-run.js";
import { registerProject } from "../../store/projects.js";
import {
  createSessionStore,
  type SessionRecord,
  type SessionStore,
} from "../../store/sessions.js";

export interface CliGlobalFlags {
  print?: boolean;
  /** Land the resumed run when it finishes (R10.1); --no-merge keeps it on its branch. */
  merge?: boolean;
  noMerge?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  answers?: string;
  plan?: string;
  work?: string;
  /** Start the resumed run in the background and return at once (R10.3). */
  detach?: boolean;
  /** Workers for the resumed run; without it the run's recorded count is used (R10.3). */
  concurrency?: number;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
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
const { ProgressLog, writeOutcome } = await import(`../run-files.js`);
const { reportOfRun, writeRunReportFile } = await import(`../run-report-io.js`);
const { renderReportMarkdown, renderReportText } = await import(`../../engine/run-report.js`);
const { runProcessOf } = await import(`../../store/run-lock.js`);
const { registry } = await import(`../registry.js`);
const { buildSettingsOverrides, concurrencyFlagProblem, landRun, mergeChoiceOf, mergeFlagsConflict, ignoredLimitFlagWarning } = await import(`./run.js`);
const { withRequestedRoles } = await import(`../../config/index.js`);

/**
 * R10.4 (known issue 41, reversed): a run is finished when its last run.finished has exit 0 and no
 * run.reopened follows it. Every other run is resumable: a failed run is reopened by the engine, and a
 * paused, interrupted or unfinished run continues. Returns undefined for a run with no log.
 */
function finishedRun(eventsPath: string): boolean | undefined {
  if (!fs.existsSync(eventsPath)) return undefined;
  const events: EngineEvent[] = [];
  try {
    for (const line of fs.readFileSync(eventsPath, "utf8").trim().split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as EngineEvent);
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    return undefined;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "run.reopened") return false;
    if (events[i].type === "run.finished") {
      // R10.5: a planned run ended on purpose, for review; it is resumed, not finished.
      if ((events[i].data as { reason?: unknown } | undefined)?.reason === "planned") return false;
      const data = (events[i].data ?? {}) as { exit_code?: unknown; status?: unknown };
      return data.exit_code === 0 || data.status === "finished";
    }
  }
  return events.some((e) => (e.data as { status?: unknown } | undefined)?.status === "finished");
}

/** True when the run's result.json says whether its work was merged to the user's branch equals `merged`. */
function resultMergedIs(runDir: string, merged: boolean): boolean {
  try {
    const result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")) as { merged?: unknown };
    return result.merged === merged;
  } catch {
    return false;
  }
}

/** A role spec as --plan and --work take it, as a role entry: provider[:model[:effort]] becomes backend, model, effort. */
function roleFromSpec(spec: string): Record<string, string> {
  const [provider, model, effort] = spec.split(":");
  return {
    ...(provider ? { backend: provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export const resumeCommand: CliCommand = {
  name: "resume",
  description: "Resume a run that did not finish (paused, interrupted, stopped or failed)",
  async execute(ctx: CommandContext): Promise<number> {
    registerProject(ctx.cwd);
    const concurrencyProblem = concurrencyFlagProblem(ctx.flags);
    if (concurrencyProblem !== undefined) {
      ctx.stderr.write(concurrencyProblem);
      return 2;
    }
    const limitWarning = ignoredLimitFlagWarning(ctx.flags);
    if (limitWarning !== undefined) ctx.stderr.write(limitWarning);
    // R10.3: the resume runs in a detached child; its own arguments minus --detach start it.
    if (ctx.flags.detach === true) {
      const { detachFrom } = await import(`../detach.js`);
      return detachFrom(ctx);
    }
    const mergeConflict = mergeFlagsConflict(ctx.flags);
    if (mergeConflict !== undefined) {
      ctx.stderr.write(mergeConflict);
      return 2;
    }
    const targetArg =
      ctx.rawArgs.length > 0
        ? ctx.rawArgs[0]
        : (ctx.flags.sessionId ?? ctx.flags.resume ?? "");
    const target = (targetArg ?? "").trim();
    const runsDir = path.join(ctx.cwd, ".substrate", "runs");
    const sessionStore =
      ctx.sessionStore ??
      createSessionStore(path.join(ctx.cwd, ".substrate"));

    let resolved: { runId: RunId; sessionId?: string };
    let forked: SessionRecord | undefined;

    if (target && fs.existsSync(path.join(ctx.cwd, ".substrate", "runs", target))) {
      // R10.4: a run named by its id reports the session that started it, so the summary's Session ID is never empty.
      const owner = (await sessionStore.list()).find((s) => s.runs.includes(target));
      resolved = { runId: target as RunId, sessionId: owner?.sessionId };
    } else {
      const session = await sessionStore.get(target);
      if (session) {
        if (session.runs.length > 0) {
          resolved = {
            runId: session.runs[session.runs.length - 1],
            sessionId: session.sessionId,
          };
        } else {
          ctx.stderr.write(`Error: session ${target} has no runs to resume\n`);
          return 2;
        }
      } else {
        ctx.stderr.write(`Error: no run or session matches '${target}'\n`);
        return 2;
      }
    }

    if (ctx.flags.forkSession) {
      if (resolved.sessionId === undefined) {
        ctx.stderr.write("Error: --fork-session requires a session\n");
        return 2;
      }
      forked = await sessionStore.fork(resolved.sessionId);
      if (ctx.flags.outputFormat !== "json") {
        ctx.stderr.write(`Forked session ${forked.sessionId}\n`);
      }
    }

    const runDir = path.join(runsDir, resolved.runId);
    const eventsPath = path.join(runDir, "events.jsonl");

    // R10.4: a finished run is not resumed; a run that is not merged says how to land it.
    if (finishedRun(eventsPath) === true) {
      ctx.stdout.write(`Run ${resolved.runId} is already finished. Nothing to resume.\n`);
      if (resultMergedIs(runDir, false)) {
        ctx.stdout.write(`not merged yet: substrate merge ${resolved.runId}\n`);
      }
      return 0;
    }

    // P2.2: a run that stopped without finishing says what happened before it continues (text mode only).
    if ((ctx.flags.outputFormat ?? "text") === "text" && runProcessOf(ctx.cwd, resolved.runId)?.alive !== true) {
      const prior = reportOfRun(ctx.cwd, resolved.runId);
      if (prior.outcome !== "planned" && prior.outcome !== "finished") ctx.stdout.write(renderReportText(prior));
    }

    // R10.2: the resume appends to the run's progress log, under a `# resumed` line.
    const progressLog = new ProgressLog(runDir, (m) => ctx.stderr.write(m));
    const formatter = createFormatter(
      ctx.flags.outputFormat ?? "text",
      ctx.stdout,
      ctx.stderr,
      { log: (text) => progressLog.append(text) },
    );

    // Read events to check if run is paused with pending questions
    let lastPaused: any;
    let isCurrentlyPaused = false;
    const runEvents: any[] = [];
    if (fs.existsSync(eventsPath)) {
      try {
        const lines = fs
          .readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            runEvents.push(ev);
            if (ev.type === "run.paused") {
              lastPaused = ev;
              isCurrentlyPaused = true;
            } else if (ev.type === "run.resumed") {
              isCurrentlyPaused = false;
            }
          } catch {}
        }
      } catch {}
    }

    // R11.1: the inputs the run was created with (request text, mode, landing, budget, lists, models).
    const run = recordedRunOptions(runEvents as EngineEvent[]);
    const hasPendingQuestions =
      isCurrentlyPaused &&
      lastPaused?.data?.reason === "needs_human" &&
      Boolean(lastPaused?.data?.questions_path);

    if (ctx.flags.answers !== undefined && !hasPendingQuestions) {
      ctx.stderr.write(`Error: run ${resolved.runId} has no pending questions\n`);
      return 2;
    }

    // R10.2: the resume is going ahead; its progress log gets a `# resumed` line first.
    progressLog.header(`resumed ${new Date().toISOString()}`);
    if (hasPendingQuestions) {
      const { parseQuestions } = await import(`../questions.js`);
      let questions: Question[] = [];
      const qPath = lastPaused.data.questions_path;
      if (fs.existsSync(qPath)) {
        try {
          questions = parseQuestions(fs.readFileSync(qPath, "utf8"));
        } catch {}
      } else if (Array.isArray(lastPaused.data.questions)) {
        questions = lastPaused.data.questions;
      }

      const filledAnswers: Array<{ id: string; text: string }> = [];

      if (ctx.flags.answers !== undefined) {
        let rawAnswers: string;
        if (ctx.flags.answers === "-") {
          rawAnswers = ctx.stdin ?? "";
        } else {
          const ansPath = path.resolve(ctx.cwd, ctx.flags.answers);
          if (!fs.existsSync(ansPath)) {
            ctx.stderr.write(`Error: answers file '${ctx.flags.answers}' not found\n`);
            return 2;
          }
          rawAnswers = fs.readFileSync(ansPath, "utf8");
        }

        let parsedJson: any;
        try {
          parsedJson = JSON.parse(rawAnswers);
        } catch {
          ctx.stderr.write("Error: invalid JSON in answers\n");
          return 2;
        }

        if (!parsedJson || !Array.isArray(parsedJson.answers)) {
          ctx.stderr.write("Error: answers must contain an 'answers' array\n");
          return 2;
        }

        const knownQuestionIds = new Set(questions.map((q) => q.id));
        for (const ans of parsedJson.answers) {
          if (!ans || typeof ans.id !== "string" || !knownQuestionIds.has(ans.id)) {
            ctx.stderr.write(`Error: unknown question id ${ans?.id}\n`);
            return 2;
          }
        }

        const ansMap = new Map(parsedJson.answers.map((a: any) => [a.id, a.text]));
        for (const q of questions) {
          if (ansMap.has(q.id)) {
            filledAnswers.push({ id: q.id, text: String(ansMap.get(q.id)) });
          } else if (q.default !== undefined) {
            filledAnswers.push({ id: q.id, text: q.default });
          } else {
            ctx.stderr.write(`Error: question ${q.id} has no default; pass --answers\n`);
            return 2;
          }
        }
      } else {
        // No --answers: use each question's default
        for (const q of questions) {
          if (q.default !== undefined) {
            filledAnswers.push({ id: q.id, text: q.default });
          } else {
            ctx.stderr.write(`Error: question ${q.id} has no default; pass --answers\n`);
            return 2;
          }
        }
      }

      const lastSeq = runEvents.length > 0 ? runEvents[runEvents.length - 1].seq : 0;
      const resumedEvt: EngineEvent = {
        v: 1,
        seq: lastSeq + 1,
        ts: new Date().toISOString(),
        run_id: resolved.runId,
        type: "run.resumed",
        data: { answers: filledAnswers },
      };
      fs.appendFileSync(eventsPath, JSON.stringify(resumedEvt) + "\n", "utf8");
      formatter.onEvent(resumedEvt);
    }

    // R8.2 (known issue 18): a resume uses the models the run started with, recorded on its
    // run.created event. A role named again (--plan or --model for the planner, --work or
    // --worker-model for the worker) replaces the recorded model; --effort still applies.
    const recorded = (run.requested_roles ?? {}) as Record<string, Record<string, unknown> | undefined>;
    // R11.1: the budget, verify and context lists, tool lists, sandbox, history flag and worker count the run
    // recorded sit under the flags given now (R10.3 kept the worker count the same way).
    const overrides0 = deepMerge(recordedSettingsOverrides(run), buildSettingsOverrides(ctx.flags, ctx.flags.mode)) as ReturnType<typeof buildSettingsOverrides>;
    const roles: Record<string, Record<string, unknown> | undefined> = { ...((overrides0.roles ?? {}) as typeof roles) };
    if (ctx.flags.plan !== undefined) {
      roles.planner = { ...(roles.planner ?? {}), ...roleFromSpec(ctx.flags.plan) };
    } else if (ctx.flags.model === undefined && recorded.planner !== undefined) {
      roles.planner = { ...recorded.planner, ...(roles.planner ?? {}) };
    }
    if (ctx.flags.work !== undefined) {
      roles.worker = { ...(roles.worker ?? {}), ...roleFromSpec(ctx.flags.work) };
    } else if (ctx.flags.workerModel === undefined && ctx.flags.model === undefined && recorded.worker !== undefined) {
      roles.worker = { ...recorded.worker, ...(roles.worker ?? {}) };
    }
    let overrides = withRequestedRoles({ ...overrides0, roles } as typeof overrides0);

    // R10.5: a planned run is reviewed before it runs. It needs a worker (named now, or recorded by
    // `run --review`), and its manifest and specs, as the person left them, must pass the ingest checks.
    // Nothing is spent here: a refused plan exits 2 and the run stays planned.
    const { reduceEvents } = await import(`../../observe/run-observe.js`);
    const plannedRun = reduceEvents(resolved.runId, runEvents as EngineEvent[]).state === "PLANNED";
    if (plannedRun) {
      if (ctx.flags.work === undefined && ctx.flags.workerModel === undefined && recorded.worker === undefined) {
        ctx.stderr.write("Error: a worker model is required: --work <provider:model[:effort]>\n");
        return 2;
      }
      const { ingestPlanDraft } = await import(`../../roles/planner.js`);
      let reviewSettings;
      try {
        reviewSettings = await loadSettings({ projectDir: ctx.cwd, settingsFile: ctx.flags.settings, flags: overrides });
      } catch (err: any) {
        ctx.stderr.write(`Error loading settings: ${err.message}\n`);
        return 2;
      }
      const reviewed = await ingestPlanDraft({ runDir, repoRoot: ctx.cwd, settings: reviewSettings });
      if (!reviewed.ok) {
        ctx.stderr.write(`Error: the plan does not pass review; edit it in .substrate/runs/${resolved.runId}/ and resume again:\n`);
        for (const d of reviewed.diagnostics) ctx.stderr.write(`  ${d}\n`);
        return 2;
      }
    }

    let engine = ctx.engine;
    if (!engine) {
      try {
        const settings = await loadSettings({
          projectDir: ctx.cwd,
          settingsFile: ctx.flags.settings,
          flags: overrides,
        });
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

    const originalMode = run.mode;
    const originalPermissionMode = run.permission_mode;

    const resumeOpts: Partial<RunOptions> = {
      cwd: ctx.cwd,
      mode: (ctx.flags.mode ?? originalMode) as any,
      // R10.5: a plan-only run was planned under `plan` permissions; its tasks run under the default ones.
      permission_mode: (ctx.flags.permissionMode ?? (plannedRun ? "dontAsk" : originalPermissionMode)) as any,
      overrides,
      signal: ctx.signal,
      onEvent: (event) => {
        runEvents.push(event);
        formatter.onEvent(event);
      },
    };

    // A run the engine does not resume from a pause emits no run.resumed; this names the resume instead.
    if (!isCurrentlyPaused) formatter.beginResume(resolved.runId);
    try {
      const resumed = await engine.resume(resolved.runId, resumeOpts);
      if (resumed.pause_reason === "needs_human" && resumed.questions === undefined) {
        const qPath = path.join(runDir, "QUESTIONS.md");
        if (fs.existsSync(qPath)) {
          const { parseQuestions } = await import(`../questions.js`);
          try {
            resumed.questions = parseQuestions(fs.readFileSync(qPath, "utf8"));
          } catch {}
        }
      }
      // R10.1: a resumed run that finishes lands like a run does, unless the caller or the setting says no.
      const landSettings = await loadSettings({ projectDir: ctx.cwd, settingsFile: ctx.flags.settings, flags: overrides });
      const landed = await landRun(ctx, resumed, {
        // R10.3: the landing the run recorded on run.created, unless --merge or --no-merge is given again (old logs: the setting).
        mergeRequested: mergeChoiceOf(ctx.flags) ?? (typeof run.merge === "boolean" ? run.merge : landSettings.git?.auto_merge === true),
        events: runEvents,
      });
      const summary = landed.summary;
      // R10.5: a resumed run that ends planned again names the review step, as `plan` does (status.ts agrees).
      if (summary.status === "planned") {
        summary.next = [
          recorded.worker !== undefined
            ? `substrate resume ${summary.run_id}`
            : `substrate resume ${summary.run_id} --work <provider:model[:effort]>`,
        ];
      }
      // P2.2: the report is read from the run's files, as it stands after the resume.
      const report = reportOfRun(ctx.cwd, summary.run_id, summary);
      if (forked) {
        await sessionStore.addRun(forked.sessionId, summary.run_id);
        formatter.onSummary(summary, forked.sessionId, report);
      } else {
        formatter.onSummary(summary, resolved.sessionId ?? "", report);
      }
      await formatter.flush();
      // R10.2: a resumed run's outcome replaces the earlier summary.txt and result.json.
      writeOutcome(
        runDir,
        formatter.renderedSummary() ?? "",
        summaryPayload(summary, forked ? forked.sessionId : (resolved.sessionId ?? ""), runEvents, report),
        renderReportMarkdown(report),
      );

      return landed.exitCode;
    } catch (err: any) {
      if (err instanceof RunLockError) {
        formatter.onError(err);
        await formatter.flush();
        return 2;
      }
      // P2.2: an exception that ends the resume still writes the run's REPORT.md, from what is on disk.
      const unfinished = writeRunReportFile(ctx.cwd, resolved.runId);
      if (err.name === "AbortError" || err.message?.includes("SIGINT")) {
        if (unfinished !== undefined && (ctx.flags.outputFormat ?? "text") === "text") ctx.stdout.write(renderReportText(unfinished));
        return 130;
      }
      if (err.message?.includes("SIGTERM")) {
        if (unfinished !== undefined && (ctx.flags.outputFormat ?? "text") === "text") ctx.stdout.write(renderReportText(unfinished));
        return 143;
      }
      formatter.onError(err);
      if (unfinished !== undefined && (ctx.flags.outputFormat ?? "text") === "text") ctx.stdout.write(renderReportText(unfinished));
      await formatter.flush();
      return 1;
    }
  },
};

registry.register(resumeCommand);
