import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { loadSettings } from "../../config/index.js";
import {
  groupUsage,
  ledgerPaths,
  readUsageLedger,
  rebuildFromEvents,
  type UsageGroupBy,
  type UsageRow,
} from "../../ledger/usage.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  provider?: string;
  run?: string;
  by?: string;
  since?: string;
  allProjects?: boolean;
  cache?: boolean;
  rebuild?: boolean;
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
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);

const BY_VALUES = ["model", "provider", "role", "run", "task", "class", "day"] as const;

function reportError(ctx: CommandContext, message: string, jsonMode: boolean): number {
  ctx.stderr.write(`Error: ${message}\n`);
  if (jsonMode) {
    ctx.stdout.write(`${JSON.stringify({ error: message })}\n`);
  }
  return 2;
}

// Every number in the report is a sum of the ledger's own fields; no price is
// computed here.
function sumTotals(rows: UsageRow[]): UsageRow {
  const totals: UsageRow = {
    group: "total",
    runs: 0,
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    unknown_cost_rows: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
  };
  for (const row of rows) {
    totals.runs += row.runs;
    totals.calls += row.calls;
    totals.input_tokens += row.input_tokens;
    totals.output_tokens += row.output_tokens;
    totals.cost_usd += row.cost_usd;
    totals.unknown_cost_rows += row.unknown_cost_rows;
    totals.cache_read_tokens += row.cache_read_tokens;
    totals.cache_write_tokens += row.cache_write_tokens;
    totals.reasoning_tokens += row.reasoning_tokens;
  }
  return totals;
}

function costCell(row: UsageRow): string {
  const cell = `$${row.cost_usd.toFixed(4)}`;
  return row.unknown_cost_rows > 0 ? `${cell} (+ ${row.unknown_cost_rows} unknown)` : cell;
}

function jsonRow(row: UsageRow, cache: boolean): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    group: row.group,
    runs: row.runs,
    calls: row.calls,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: row.cost_usd,
    unknown_cost_rows: row.unknown_cost_rows,
  };
  if (cache) {
    obj.cache_read_tokens = row.cache_read_tokens;
    obj.cache_write_tokens = row.cache_write_tokens;
    obj.reasoning_tokens = row.reasoning_tokens;
  }
  return obj;
}

// Totals are the numbers of a summed row without the group label.
function jsonTotals(totals: UsageRow, cache: boolean): Record<string, unknown> {
  const obj = jsonRow(totals, cache);
  delete obj.group;
  return obj;
}

export const usageCommand: CliCommand = {
  name: "usage",
  aliases: ["cost"],
  description: "Report tokens and cost from the usage ledger",

  async execute(ctx: CommandContext): Promise<number> {
    const jsonMode = ctx.flags.outputFormat === "json";

    const byValue = ctx.flags.by ?? "model";
    if (!BY_VALUES.includes(byValue as UsageGroupBy)) {
      return reportError(ctx, `invalid --by '${byValue}'`, jsonMode);
    }
    const by = byValue as UsageGroupBy;

    const since = ctx.flags.since;
    let cutoff: number | null = null;
    if (since !== undefined) {
      if (/^\d+d$/.test(since)) {
        cutoff = Date.now() - Number(since.slice(0, -1)) * 24 * 60 * 60 * 1000;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
        cutoff = Date.parse(`${since}T00:00:00Z`);
      } else {
        return reportError(
          ctx,
          `invalid --since '${since}' (use 7d or YYYY-MM-DD)`,
          jsonMode
        );
      }
    }

    const settings = await loadSettings({
      projectDir: ctx.cwd,
      settingsFile: ctx.flags.settings,
    });
    const globalEnabled = settings.usage?.global ?? true;
    const paths = ledgerPaths({ projectRoot: ctx.cwd, globalEnabled, env: process.env });

    const source = ctx.flags.allProjects ? paths.global : paths.project;
    // source can only be undefined when --all-projects is set (the project
    // ledger path is always defined), so this guard is the no-global-mirror case.
    if (source === undefined) {
      ctx.stdout.write("no global mirror\n");
      return 0;
    }

    if (ctx.flags.rebuild) {
      const runsDir = path.join(ctx.cwd, ".substrate", "runs");
      const runDirs = fs.existsSync(runsDir)
        ? fs.readdirSync(runsDir).filter((name) => fs.statSync(path.join(runsDir, name)).isDirectory())
        : [];
      let rebuiltLines = 0;
      for (const name of runDirs.sort()) {
        rebuiltLines += rebuildFromEvents(path.join(runsDir, name), paths);
      }
      ctx.stdout.write(`rebuilt ${rebuiltLines} line(s) from ${runDirs.length} run(s)\n`);
    }

    const runFilter = ctx.flags.run ?? ctx.rawArgs[0];

    const entries = readUsageLedger(source).filter((entry) => {
      if (ctx.flags.provider && entry.backend !== ctx.flags.provider) return false;
      if (ctx.flags.model && entry.model !== ctx.flags.model) return false;
      if (runFilter && entry.run_id !== runFilter) return false;
      if (cutoff !== null) {
        const ts = Date.parse(entry.ts);
        if (Number.isNaN(ts) || ts < cutoff) return false;
      }
      return true;
    });

    const cacheOn = ctx.flags.cache === true;
    const rows = groupUsage(entries, by, { cache: cacheOn });

    if (entries.length === 0) {
      if (jsonMode) {
        const report = {
          by,
          since: since ?? null,
          filters: {
            provider: ctx.flags.provider ?? null,
            model: ctx.flags.model ?? null,
            run: runFilter ?? null,
          },
          rows: [],
          totals: jsonTotals(sumTotals(rows), cacheOn),
        };
        ctx.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        ctx.stdout.write("no usage recorded\n");
      }
      return 0;
    }

    if (jsonMode) {
      const report = {
        by,
        since: since ?? null,
        filters: {
          provider: ctx.flags.provider ?? null,
          model: ctx.flags.model ?? null,
          run: runFilter ?? null,
        },
        rows: rows.map((row) => jsonRow(row, cacheOn)),
        totals: jsonTotals(sumTotals(rows), cacheOn),
      };
      ctx.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    }

    const headers = ["group", "runs", "calls", "input", "output", "cost"];
    if (cacheOn) {
      headers.push("cache_read", "cache_write", "reasoning");
    }
    ctx.stdout.write(`${headers.join(" ")}\n`);

    for (const row of [...rows, sumTotals(rows)]) {
      const cells = [row.group, row.runs, row.calls, row.input_tokens, row.output_tokens, costCell(row)];
      if (cacheOn) {
        cells.push(row.cache_read_tokens, row.cache_write_tokens, row.reasoning_tokens);
      }
      ctx.stdout.write(`${cells.join(" ")}\n`);
    }
    return 0;
  },
};

registry.register(usageCommand);
