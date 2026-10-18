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

export const modelsCommand: CliCommand = {
  name: "models",
  description: "Show the model catalog: providers, models, pricing, and routing slots",
  async execute(ctx: CommandContext): Promise<number> {
    const settings = await loadSettings({
      projectDir: ctx.cwd,
      settingsFile: ctx.flags.settings,
    });

    const jsonMode = ctx.flags.outputFormat === "json";
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
