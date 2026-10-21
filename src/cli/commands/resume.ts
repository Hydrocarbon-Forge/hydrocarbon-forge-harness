import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, EngineEvent, PermissionMode, Question, RunId, RunOptions } from "../../contracts/index.js";
import { createEngine } from "../../engine/engine.js";
import { reduce, type EngineState } from "../../engine/reducer.js";
import { failedRunAdvice, planHasIntegrationVerify } from "../../engine/failed-run.js";
import { loadSettings, sandboxProblem } from "../../config/index.js";
import { RunLockError } from "../../store/run-lock.js";
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
const { ProgressLog, writeOutcome } = await import(`../run-files.js`);
const { registry } = await import(`../registry.js`);
const { buildSettingsOverrides, concurrencyFlagProblem, landRun, mergeChoiceOf, mergeFlagsConflict } = await import(`./run.js`);
const { withRequestedRoles } = await import(`../../config/index.js`);

/**
 * How a run ended, from its event log (known issue 41): "finished" when its last run.finished has exit
 * 0, "failed" when it has any other exit. undefined for a run that has not ended (paused, interrupted,
 * or never finished), which resume continues. For a failed run it also says what the run can do
 * instead: whether a passed task can land with `merge --partial`, and whether it never planned.
 */
interface RunEnding {
  outcome: "finished" | "failed";
  partialLandable: boolean;
  planningFailed: boolean;
}

function runEndingOf(eventsPath: string, runId: string, runDir: string): RunEnding | undefined {
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
  const finished = [...events].reverse().find((e) => e.type === "run.finished");
  if (finished === undefined) {
    return events.some((e) => (e.data as { status?: unknown } | undefined)?.status === "finished")
      ? { outcome: "finished", partialLandable: false, planningFailed: false }
      : undefined;
  }
  const data = (finished.data ?? {}) as { exit_code?: unknown; status?: unknown };
  if (data.exit_code === 0 || data.status === "finished") {
    return { outcome: "finished", partialLandable: false, planningFailed: false };
  }
  let state: EngineState = { run_id: runId as RunId, state: "CREATED", tasks: {}, usage: { total_usd: 0, by_role: {} }, checkpoints: [] };
  for (const evt of events) state = reduce(state, evt);
  return {
    outcome: "failed",
    partialLandable: events.some((e) => e.type === "task.merged") && planHasIntegrationVerify(runDir),
    planningFailed: Object.keys(state.tasks).length === 0,
  };
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
  description: "Resume a paused or interrupted Substrate run",
  async execute(ctx: CommandContext): Promise<number> {
    const concurrencyProblem = concurrencyFlagProblem(ctx.flags);
    if (concurrencyProblem !== undefined) {
      ctx.stderr.write(concurrencyProblem);
      return 2;
    }
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
      resolved = { runId: target as RunId, sessionId: undefined };
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

    const ending = runEndingOf(eventsPath, resolved.runId, runDir);
    if (ending?.outcome === "finished") {
      ctx.stdout.write(
        `Run ${resolved.runId} is already finished. Nothing to resume.\n`,
      );
      return 0;
    }
    if (ending?.outcome === "failed") {
      // Known issue 41: the engine drops a failed run's tasks by design, so it is not resumed.
      const advice = failedRunAdvice(resolved.runId, {
        partialLandable: ending.partialLandable,
        planningFailed: ending.planningFailed,
      });
      const message = `Run ${resolved.runId} failed and cannot be resumed. ${advice.whatToDo}`;
      if (ctx.flags.outputFormat === "json") {
        ctx.stdout.write(JSON.stringify({ error: message, failure_class: "not_resumable", run_id: resolved.runId }) + "\n");
      } else if (ctx.flags.outputFormat === "stream-json") {
        ctx.stdout.write(JSON.stringify({ type: "result", subtype: "error_failed", is_error: true, error: message, failure_class: "not_resumable" }) + "\n");
      } else {
        ctx.stdout.write(message + "\n");
      }
      return 1;
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

    const createdEvt = runEvents.find((e) => e.type === "run.created");
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
    const recorded = (createdEvt?.data?.requested_roles ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const overrides0 = buildSettingsOverrides(ctx.flags, ctx.flags.mode);
    // R10.3: the worker count the run recorded, unless --concurrency is given again.
    if (ctx.flags.concurrency === undefined && typeof createdEvt?.data?.concurrency === "number") {
      overrides0.concurrency = { workers: createdEvt.data.concurrency };
    }
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

    const originalMode = createdEvt?.data?.mode;
    const originalPermissionMode = createdEvt?.data?.permission_mode;

    const resumeOpts: Partial<RunOptions> = {
      cwd: ctx.cwd,
      mode: (ctx.flags.mode ?? originalMode) as any,
      permission_mode: (ctx.flags.permissionMode ?? originalPermissionMode) as any,
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
        mergeRequested: mergeChoiceOf(ctx.flags) ?? (typeof createdEvt?.data?.merge === "boolean" ? createdEvt.data.merge : landSettings.git?.auto_merge === true),
        events: runEvents,
      });
      const summary = landed.summary;
      if (forked) {
        await sessionStore.addRun(forked.sessionId, summary.run_id);
        formatter.onSummary(summary, forked.sessionId);
      } else {
        formatter.onSummary(summary, resolved.sessionId ?? "");
      }
      await formatter.flush();
      // R10.2: a resumed run's outcome replaces the earlier summary.txt and result.json.
      writeOutcome(
        runDir,
        formatter.renderedSummary() ?? "",
        summaryPayload(summary, forked ? forked.sessionId : (resolved.sessionId ?? ""), runEvents),
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

registry.register(resumeCommand);
