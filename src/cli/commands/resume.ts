import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, EngineEvent, PermissionMode, Question, RunId, RunOptions } from "../../contracts/index.js";
import { createEngine } from "../../engine/engine.js";
import { loadSettings, sandboxProblem } from "../../config/index.js";
import { RunLockError } from "../../store/run-lock.js";
import {
  createSessionStore,
  type SessionRecord,
  type SessionStore,
} from "../../store/sessions.js";

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
  noGovernor?: boolean;
  answers?: string;
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
const { registry } = await import(`../registry.js`);
const { buildSettingsOverrides } = await import(`./run.js`);

function isRunAlreadyFinished(eventsPath: string): boolean {
  if (!fs.existsSync(eventsPath)) return false;
  try {
    const lines = fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "run.finished" || ev.data?.status === "finished") return true;
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export const resumeCommand: CliCommand = {
  name: "resume",
  description: "Resume a paused or interrupted Substrate run",
  async execute(ctx: CommandContext): Promise<number> {
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

    if (isRunAlreadyFinished(eventsPath)) {
      ctx.stdout.write(
        `Run ${resolved.runId} is already finished. Nothing to resume.\n`,
      );
      return 0;
    }

    const formatter = createFormatter(
      ctx.flags.outputFormat ?? "text",
      ctx.stdout,
      ctx.stderr,
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

    const hasPendingQuestions =
      isCurrentlyPaused &&
      lastPaused?.data?.reason === "needs_human" &&
      Boolean(lastPaused?.data?.questions_path);

    if (ctx.flags.answers !== undefined && !hasPendingQuestions) {
      ctx.stderr.write(`Error: run ${resolved.runId} has no pending questions\n`);
      return 2;
    }

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

    const overrides = buildSettingsOverrides(ctx.flags, ctx.flags.mode);

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

    const createdEvt = runEvents.find((e) => e.type === "run.created");
    const originalMode = createdEvt?.data?.mode;
    const originalPermissionMode = createdEvt?.data?.permission_mode;

    const resumeOpts: Partial<RunOptions> = {
      cwd: ctx.cwd,
      mode: (ctx.flags.mode ?? originalMode) as any,
      permission_mode: (ctx.flags.permissionMode ?? originalPermissionMode) as any,
      overrides,
      signal: ctx.signal,
      onEvent: (event) => formatter.onEvent(event),
    };

    try {
      const summary = await engine.resume(resolved.runId, resumeOpts);
      if (summary.pause_reason === "needs_human" && summary.questions === undefined) {
        const qPath = path.join(runDir, "QUESTIONS.md");
        if (fs.existsSync(qPath)) {
          const { parseQuestions } = await import(`../questions.js`);
          try {
            summary.questions = parseQuestions(fs.readFileSync(qPath, "utf8"));
          } catch {}
        }
      }
      if (forked) {
        await sessionStore.addRun(forked.sessionId, summary.run_id);
        formatter.onSummary(summary, forked.sessionId);
      } else {
        formatter.onSummary(summary, resolved.sessionId ?? "");
      }
      await formatter.flush();

      return summary.exit_code;
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
