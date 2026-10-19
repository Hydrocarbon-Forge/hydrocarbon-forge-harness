import type { Effort, Engine, HarnessAdapter, PermissionMode } from "../../contracts/index.js";
import { createAdapters } from "../../backends/registry.js";
import { loadSettings, modelCacheFile } from "../../config/index.js";
import type { SessionStore } from "../../store/sessions.js";

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
  provider?: string;
  refresh?: boolean;
  stats?: boolean;
  since?: string;
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
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);

function priceText(price: { input: number; output: number } | null): string {
  return price ? `${price.input}/${price.output} per Mtok` : "unpriced";
}

// Same --since forms as `usage`: 7d (days back from now) or YYYY-MM-DD (UTC midnight).
function sinceCutoff(since: string): number | null {
  let cutoff: number;
  if (/^\d+d$/.test(since)) {
    cutoff = Date.now() - Number(since.slice(0, -1)) * 24 * 60 * 60 * 1000;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    cutoff = Date.parse(`${since}T00:00:00Z`);
  } else {
    return null;
  }
  return Number.isNaN(cutoff) ? null : cutoff;
}

function percentText(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function tokensText(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function costPerPassedText(stat: { cost_unknown: boolean; avg_cost_per_passed_task: number | null }): string {
  if (stat.cost_unknown) return "unknown";
  return stat.avg_cost_per_passed_task === null ? "-" : `$${stat.avg_cost_per_passed_task.toFixed(4)}`;
}

async function runModelStats(ctx: CommandContext, jsonMode: boolean): Promise<number> {
  const since = ctx.flags.since;
  let cutoff: number | undefined;
  if (since !== undefined) {
    const parsed = sinceCutoff(since);
    if (parsed === null) {
      ctx.stderr.write(`Error: invalid --since '${since}' (use 7d or YYYY-MM-DD)\n`);
      if (jsonMode) {
        ctx.stdout.write(`${JSON.stringify({ error: `invalid --since '${since}' (use 7d or YYYY-MM-DD)` })}\n`);
      }
      return 2;
    }
    cutoff = parsed;
  }

  const { modelStats } = await import(`../model-catalog.js`);
  const stats = modelStats({ projectRoot: ctx.cwd, since: cutoff });

  if (jsonMode) {
    ctx.stdout.write(`${JSON.stringify({ since: since ?? null, stats })}\n`);
    return 0;
  }

  const providers = [...new Set(stats.map((stat) => stat.provider))];
  for (const provider of providers) {
    ctx.stdout.write(`== ${provider} ==\n`);
    for (const stat of stats.filter((s) => s.provider === provider)) {
      const cells = [
        stat.model,
        String(stat.tasks),
        percentText(stat.first_pass_rate),
        percentText(stat.heal_rate),
        String(stat.replans),
        tokensText(stat.avg_input_tokens),
        tokensText(stat.avg_output_tokens),
        costPerPassedText(stat),
      ];
      if (stat.note !== undefined) cells.push(stat.note);
      ctx.stdout.write(`${cells.join("\t")}\n`);
    }
  }
  const totalTasks = stats.reduce((sum, stat) => sum + stat.tasks, 0);
  ctx.stdout.write(`== all models ==\n${stats.length} model(s)\t${totalTasks} task(s)\n`);
  return 0;
}

export const modelsCommand: CliCommand = {
  name: "models",
  description: "Show the model catalog: providers, models, pricing, and routing slots",
  async execute(ctx: CommandContext): Promise<number> {
    const jsonMode = ctx.flags.outputFormat === "json";
    if (ctx.flags.stats === true) {
      return runModelStats(ctx, jsonMode);
    }

    const settings = await loadSettings({
      projectDir: ctx.cwd,
      settingsFile: ctx.flags.settings,
    });
    const adapters = createAdapters(settings);

    const provider = ctx.flags.provider;
    if (provider !== undefined && !(provider in adapters)) {
      ctx.stderr.write(`Error: unknown provider ${provider}\n`);
      if (jsonMode) {
        ctx.stdout.write(`${JSON.stringify({ error: `unknown provider ${provider}` })}\n`);
      }
      return 2;
    }

    const { buildCatalog } = await import(`../model-catalog.js`);

    const scoped: Record<string, HarnessAdapter> = {};
    for (const [name, adapter] of Object.entries(adapters)) {
      if (provider === undefined || name === provider) {
        scoped[name] = adapter;
      }
    }

    const catalog = await buildCatalog({
      settings,
      adapters: scoped,
      refresh: ctx.flags.refresh === true,
      cacheFile: modelCacheFile(ctx.cwd),
    });

    if (jsonMode) {
      ctx.stdout.write(`${JSON.stringify(catalog)}\n`);
      return 0;
    }

    for (const entry of catalog.providers) {
      const state = entry.installed ? "installed" : "not installed";
      const pinLine = entry.pin_matches ? "matches" : "does not match";
      ctx.stdout.write(
        `== ${entry.provider} (${state}, version ${entry.version ?? "-"}, pin ${entry.version_pin ?? "-"} ${pinLine}) ==\n`
      );
      for (const model of entry.models) {
        ctx.stdout.write(
          `${model.id}\t${model.efforts.join(",") || "-"}\t${priceText(model.price_per_mtok)}\t${model.slots.join(",") || "-"}\n`
        );
      }
    }

    ctx.stdout.write(`\n== all models ==\n`);
    for (const model of catalog.all_models) {
      ctx.stdout.write(
        `${model.provider}\t${model.id}\t${model.efforts.join(",") || "-"}\t${priceText(model.price_per_mtok)}\t${model.slots.join(",") || "-"}\n`
      );
    }

    return 0;
  },
};

registry.register(modelsCommand);
