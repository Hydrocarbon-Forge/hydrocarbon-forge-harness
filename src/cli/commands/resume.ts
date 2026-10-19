import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode, RunId, RunOptions } from "../../contracts/index.js";
import { EngineImpl } from "../../engine/engine.js";
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
        engine = new EngineImpl({ settings });
      } catch (err: any) {
        ctx.stderr.write(`Error loading settings: ${err.message}\n`);
        return 2;
      }
    }

    const resumeOpts: Partial<RunOptions> = {
      cwd: ctx.cwd,
      overrides,
      signal: ctx.signal,
      onEvent: (event) => formatter.onEvent(event),
    };

    try {
      const summary = await engine.resume(resolved.runId, resumeOpts);
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
