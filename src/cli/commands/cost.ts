import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
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

export const costCommand: CliCommand = {
  name: "cost",
  description: "Display cost telemetry and token usage breakdowns",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0];

    if (runId) {
      const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
      const eventsFile = path.join(runDir, "events.jsonl");

      if (!fs.existsSync(eventsFile)) {
        ctx.stderr.write(`Error: Run '${runId}' not found at ${eventsFile}\n`);
        return 2;
      }

      const content = fs.readFileSync(eventsFile, "utf8");
      const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);

      let totalUsd = 0;
      const byRole: Record<string, number> = {};
      const byModel: Record<string, number> = {};

      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "usage") {
            const data = ev.data ?? {};
            const cost = Number(data.cost_usd ?? 0);
            totalUsd += cost;

            const role = data.role ?? "worker";
            byRole[role] = (byRole[role] ?? 0) + cost;

            const model = data.model ?? "default";
            byModel[model] = (byModel[model] ?? 0) + cost;
          }
        } catch {
          // ignore
        }
      }

      ctx.stdout.write(`=== Cost Summary for Run ${runId} ===\n\n`);
      ctx.stdout.write(`Total Cost: $${totalUsd.toFixed(2)}\n\n`);
      ctx.stdout.write(`By Role:\n`);
      for (const [r, c] of Object.entries(byRole)) {
        ctx.stdout.write(`  ${r}: $${c.toFixed(2)}\n`);
      }
      ctx.stdout.write(`By Model:\n`);
      for (const [m, c] of Object.entries(byModel)) {
        ctx.stdout.write(`  ${m}: $${c.toFixed(2)}\n`);
      }
      return 0;
    }

    // Ledger aggregate spend
    const ledgerFile = path.join(ctx.cwd, ".substrate", "ledger", "usage.jsonl");
    if (!fs.existsSync(ledgerFile)) {
      ctx.stdout.write(`Total Spend: $0.00\n`);
      return 0;
    }

    const content = fs.readFileSync(ledgerFile, "utf8");
    const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);

    let totalSpend = 0;
    const byRole: Record<string, number> = {};
    const byModel: Record<string, number> = {};

    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const cost = Number(rec.cost_usd ?? 0);
        totalSpend += cost;

        if (rec.role) {
          byRole[rec.role] = (byRole[rec.role] ?? 0) + cost;
        }
        if (rec.model) {
          byModel[rec.model] = (byModel[rec.model] ?? 0) + cost;
        }
      } catch {
        // ignore
      }
    }

    ctx.stdout.write(`=== Aggregate Ledger Spend ===\n\n`);
    ctx.stdout.write(`Total Spend: $${totalSpend.toFixed(2)}\n\n`);
    if (Object.keys(byRole).length > 0) {
      ctx.stdout.write(`By Role:\n`);
      for (const [r, c] of Object.entries(byRole)) {
        ctx.stdout.write(`  ${r}: $${c.toFixed(2)}\n`);
      }
    }
    if (Object.keys(byModel).length > 0) {
      ctx.stdout.write(`By Model:\n`);
      for (const [m, c] of Object.entries(byModel)) {
        ctx.stdout.write(`  ${m}: $${c.toFixed(2)}\n`);
      }
    }

    return 0;
  },
};

registry.register(costCommand);
