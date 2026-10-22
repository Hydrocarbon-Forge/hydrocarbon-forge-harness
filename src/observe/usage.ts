import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cost and token totals for the web API (docs/design/web-ui.md, sections 5.1 and 5.2 GET /api/usage). A total
// is the sum of its rows. A row whose price is missing (cost_source "unknown") adds 0 to the cost and is
// counted in unknown_cost_rows, so the UI shows "unknown" rather than $0 (DECISIONS A7).

export type CostSource = "reported" | "computed" | "unknown";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_source: CostSource;
  unknown_cost_rows: number;
}

export interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_source: CostSource;
}

export interface UsageReport {
  total: Usage;
  by_project: { project_id: string; usage: Usage }[];
  by_model: { provider: string; model: string; usage: Usage }[];
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_source: "reported", unknown_cost_rows: 0 };
}

/** The sum of rows. The total's cost source is "unknown" if any row is unknown, else "computed" if any row is computed. */
export function usageOfRows(rows: readonly UsageRow[]): Usage {
  const total = emptyUsage();
  let computed = false;
  for (const row of rows) {
    total.input_tokens += row.input_tokens;
    total.output_tokens += row.output_tokens;
    if (row.cost_source === "unknown") {
      total.unknown_cost_rows += 1;
    } else {
      total.cost_usd += row.cost_usd;
    }
    if (row.cost_source === "computed") computed = true;
  }
  if (total.unknown_cost_rows > 0) total.cost_source = "unknown";
  else if (computed) total.cost_source = "computed";
  return total;
}

/** A project's id: the first 12 hex characters of sha256 over its realpath (docs/design/web-ui.md, 5.1). */
export function projectIdOf(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 12);
}

interface LedgerRow extends UsageRow {
  project: string;
  backend: string;
  model: string;
  ts: string;
}

/** The global usage ledger: `$XDG_STATE_HOME/substrate/usage.jsonl`, else under ~/.local/state (DECISIONS A7). */
function globalLedgerOf(env: NodeJS.ProcessEnv): string {
  const home = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0 ? env.XDG_STATE_HOME : path.join(os.homedir(), ".local", "state");
  return path.join(home, "substrate", "usage.jsonl");
}

/** The global usage ledger's rows, torn lines left out. Empty when the ledger does not exist. */
function ledgerRowsOf(env: NodeJS.ProcessEnv): LedgerRow[] {
  const file = globalLedgerOf(env);
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: LedgerRow[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as Partial<LedgerRow>;
      if (typeof entry.project !== "string" || typeof entry.ts !== "string") continue;
      rows.push({
        project: entry.project,
        ts: entry.ts,
        backend: String(entry.backend ?? "unknown"),
        model: String(entry.model ?? "unknown"),
        input_tokens: Number(entry.input_tokens ?? 0),
        output_tokens: Number(entry.output_tokens ?? 0),
        cost_usd: Number(entry.cost_usd ?? 0),
        cost_source: (entry.cost_source ?? "unknown") as CostSource,
      });
    } catch {
      // torn line
    }
  }
  return rows;
}

/** Totals from the global usage ledger, optionally for one project path and from an ISO date on. */
export function usageReportOf(env: NodeJS.ProcessEnv, opts: { project?: string; since?: string }): UsageReport {
  const rows = ledgerRowsOf(env).filter(
    (r) => (opts.project === undefined || r.project === opts.project) && (opts.since === undefined || r.ts >= opts.since),
  );
  const byProject = new Map<string, UsageRow[]>();
  const byModel = new Map<string, { provider: string; model: string; rows: UsageRow[] }>();
  for (const row of rows) {
    const list = byProject.get(row.project) ?? [];
    list.push(row);
    byProject.set(row.project, list);
    const key = `${row.backend}\u0000${row.model}`;
    const entry = byModel.get(key) ?? { provider: row.backend, model: row.model, rows: [] };
    entry.rows.push(row);
    byModel.set(key, entry);
  }
  return {
    total: usageOfRows(rows),
    by_project: [...byProject.entries()].map(([project, list]) => ({ project_id: projectIdOf(project), usage: usageOfRows(list) })),
    by_model: [...byModel.values()].map((m) => ({ provider: m.provider, model: m.model, usage: usageOfRows(m.rows) })),
  };
}
