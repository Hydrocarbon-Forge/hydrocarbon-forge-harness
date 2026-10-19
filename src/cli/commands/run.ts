import path from "node:path";

import type { Effort, Engine, PermissionMode, RunId, RunOptions, Settings } from "../../contracts/index.js";
import { EngineImpl } from "../../engine/engine.js";
import { loadSettings, sandboxProblem } from "../../config/index.js";
import { RunLockError } from "../../store/run-lock.js";
import { createSessionStore, type SessionRecord, type SessionStore } from "../../store/sessions.js";

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

export const runCommand: CliCommand = {
  name: "run",
  description: "Execute Substrate run with specified prompt",
  async execute(ctx: CommandContext): Promise<number> {
    let prompt = ctx.rawArgs[0];
    if (!prompt && ctx.stdin && ctx.stdin.trim().length > 0) {
      prompt = ctx.stdin.trim();
    }

    if (!prompt || !prompt.trim()) {
      ctx.stderr.write("Error: prompt required on command line or stdin\n");
      return 2;
    }
    prompt = prompt.trim();

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

    const mode = ctx.flags.mode ?? "auto";
    const permission_mode = ctx.flags.permissionMode ?? "dontAsk";
    const overrides = buildSettingsOverrides(ctx.flags, mode);

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

    try {
      const summary = await engine.run(runOpts);
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

registry.register(runCommand);
