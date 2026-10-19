import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode, RunOptions } from "../../contracts/index.js";
import { EngineImpl } from "../../engine/engine.js";
import { loadSettings, sandboxProblem } from "../../config/index.js";
import { RunLockError } from "../../store/run-lock.js";
import { createSessionStore, type SessionStore } from "../../store/sessions.js";

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
  request?: string;
  plan?: string;
  work?: string;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
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

export const planCommand: CliCommand = {
  name: "plan",
  description: "Plan changes for a goal without executing modifications",
  async execute(ctx: CommandContext): Promise<number> {
    const mode = "plan";
    const permission_mode = "plan";
    let overrides = buildSettingsOverrides(ctx.flags, mode);
    let prompt = ctx.rawArgs[0];
    let runVerify: string[] | undefined;
    let runContext: string[] | undefined;

    if (ctx.flags.request !== undefined || ctx.flags.plan !== undefined || ctx.flags.work !== undefined) {
      const { loadRequest } = await import(`../request.js`);
      const reqRes = await loadRequest(ctx.flags.request, ctx.stdin, { ...ctx.flags, mode: "plan" }, {
        repoRoot: ctx.cwd,
        rawPrompt: ctx.rawArgs[0],
      });
      if (!reqRes.ok) {
        ctx.stdout.write(JSON.stringify({ error: "invalid_request", problems: reqRes.problems }) + "\n");
        return 2;
      }
      prompt = reqRes.request.goal;
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
        ctx.stderr.write("Error: prompt required\n");
        return 2;
      }
      prompt = prompt.trim();
    }

    const sessionStore =
      ctx.sessionStore ??
      createSessionStore(path.join(ctx.cwd, ".substrate"));

    let session = await sessionStore.getLatest();
    if (!session || ctx.flags.forkSession) {
      session = await sessionStore.create({ mode, prompt });
    }

    const formatter = createFormatter(
      ctx.flags.outputFormat ?? "text",
      ctx.stdout,
      ctx.stderr,
    );

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

    const runOpts: RunOptions = {
      cwd: ctx.cwd,
      mode,
      permission_mode,
      prompt,
      overrides,
      signal: ctx.signal,
      onEvent: (event) => formatter.onEvent(event),
    };
    if (runVerify) {
      (runOpts.overrides as any).verify = runVerify;
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
          try {
            summary.questions = parseQuestions(fs.readFileSync(qPath, "utf8"));
          } catch {}
        }
      }
      if (sessionStore && session) {
        await sessionStore.addRun(session.sessionId, summary.run_id, prompt);
      }
      formatter.onSummary(summary, session?.sessionId ?? "");
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

registry.register(planCommand);
