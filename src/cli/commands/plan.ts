import path from "node:path";

import type { Effort, Engine, PermissionMode, RunOptions, Settings } from "../../contracts/index.js";
import { EngineImpl } from "../../engine/engine.js";
import { loadSettings } from "../../config/index.js";
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

function buildSettingsOverrides(flags: CommandContext["flags"], mode?: string): Partial<Settings> {
  const overrides: any = {};
  if (flags.model) {
    overrides.roles = overrides.roles || {};
    overrides.roles.planner = { model: flags.model };
    if (mode !== "plan") {
      overrides.roles.worker = { model: flags.model };
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
  if (flags.allowedTools || flags.disallowedTools) {
    overrides.permissions = overrides.permissions || {};
    if (flags.allowedTools) overrides.permissions.allow = flags.allowedTools;
    if (flags.disallowedTools) overrides.permissions.deny = flags.disallowedTools;
  }
  if (flags.maxBudgetUsd !== undefined) {
    overrides.budgets = overrides.budgets || {};
    overrides.budgets.run = overrides.budgets.run || {};
    overrides.budgets.run.max_usd = flags.maxBudgetUsd;
  }
  if (flags.timeout !== undefined) {
    overrides.budgets = overrides.budgets || {};
    overrides.budgets.run = overrides.budgets.run || {};
    overrides.budgets.run.max_wall_min = flags.timeout;
  }
  if (flags.sandbox !== undefined) {
    overrides.sandbox = overrides.sandbox || {};
    overrides.sandbox.enabled = flags.sandbox;
  }
  return overrides;
}

function mapSummaryExitCode(summary: any): number {
  if (summary.status === "finished") {
    const tasks = summary.tasks ?? {};
    const anyFailed = Object.values(tasks).some(
      (t: any) => t.state === "failed" || t.failure_class !== undefined,
    );
    if (anyFailed || summary.exit_code === 1) return 1;
    return summary.exit_code ?? 0;
  }
  if (summary.status === "failed") return 1;
  if (summary.pause_reason === "budget_exhausted" || summary.exit_code === 4) {
    return 4;
  }
  if (
    summary.pause_reason === "needs_human" ||
    summary.pause_reason === "needs_approval" ||
    summary.pause_reason === "permission_denied" ||
    summary.exit_code === 3
  ) {
    return 3;
  }
  return summary.exit_code ?? 0;
}

export const planCommand: CliCommand = {
  name: "plan",
  description: "Plan changes for a goal without executing modifications",
  async execute(ctx: CommandContext): Promise<number> {
    let prompt = ctx.rawArgs[0];
    if (!prompt && ctx.stdin && ctx.stdin.trim().length > 0) {
      prompt = ctx.stdin.trim();
    }

    if (!prompt || !prompt.trim()) {
      ctx.stderr.write("Error: prompt required\n");
      return 2;
    }
    prompt = prompt.trim();

    const mode = "plan";
    const permission_mode = "plan";
    const overrides = buildSettingsOverrides(ctx.flags, mode);

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

      return mapSummaryExitCode(summary);
    } catch (err: any) {
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
