import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageLedgerEntry, type UsageRecord } from "../contracts/index.js";
import { log } from "../util/log.js";

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface LedgerPaths {
  project: string;
  global?: string;
}

export function ledgerPaths(opts: {
  projectRoot: string;
  globalEnabled: boolean;
  env: NodeJS.ProcessEnv;
}): LedgerPaths {
  const paths: LedgerPaths = {
    project: path.join(opts.projectRoot, ".substrate", "ledger", "usage.jsonl"),
  };
  if (opts.globalEnabled) {
    const base =
      opts.env.XDG_STATE_HOME && opts.env.XDG_STATE_HOME.length > 0
        ? opts.env.XDG_STATE_HOME
        : path.join(os.homedir(), ".local", "state");
    paths.global = path.join(base, "substrate", "usage.jsonl");
  }
  return paths;
}

function writeLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + "\n", "utf8");
}

// Appends one JSON line to the project ledger and, when configured, to the
// global mirror. A global write failure is logged and does not fail the run.
export function appendUsage(entry: UsageLedgerEntry, paths: LedgerPaths): void {
  UsageLedgerEntry.parse(entry);
  const line = JSON.stringify(entry);
  writeLine(paths.project, line);
  if (paths.global) {
    try {
      writeLine(paths.global, line);
    } catch (err: any) {
      log.warn(`failed to append usage to global ledger ${paths.global}: ${err?.message ?? String(err)}`);
    }
  }
}

// Removes the run's lines (and any torn lines) from both ledger files and
// re-appends one line per usage.recorded event in <runDir>/events.jsonl.
// Returns the number of appended lines.
export function rebuildFromEvents(
  runDir: string,
  paths: LedgerPaths
): number {
  const eventsPath = path.join(runDir, "events.jsonl");
  const projectRoot = path.resolve(runDir, "..", "..");
  const runId = path.basename(runDir);

  const appended: UsageLedgerEntry[] = [];
  if (fs.existsSync(eventsPath)) {
    const lines = fs.readFileSync(eventsPath, "utf8").split("\n");
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // torn or unparsable line: skipped
      }
      if (parsed?.type !== "usage.recorded") continue;
      const record = (parsed.data?.record ?? {}) as Partial<UsageRecord>;
      const data = parsed.data ?? {};
      appended.push({
        v: 1,
        ts: parsed.ts,
        project: projectRoot,
        run_id: parsed.run_id,
        task_id: typeof data.task_id === "string" ? data.task_id : undefined,
        generation: typeof data.generation === "number" ? data.generation : undefined,
        attempt: typeof data.attempt === "number" ? data.attempt : undefined,
        role: data.role,
        class: typeof data.class === "string" ? data.class : undefined,
        backend: record.backend ?? "fake",
        model: record.model ?? "unknown",
        effort: undefined,
        input_tokens: record.input_tokens ?? 0,
        output_tokens: record.output_tokens ?? 0,
        cache_read_tokens: record.cache_read_tokens,
        cache_write_tokens: record.cache_write_tokens,
        reasoning_tokens: record.reasoning_tokens,
        cost_usd: record.cost_usd ?? 0,
        cost_source: record.cost_source ?? "unknown",
      });
    }
  }

  for (const file of [paths.project, paths.global].filter((f): f is string => Boolean(f))) {
    let kept: string[] = [];
    if (fs.existsSync(file)) {
      const rawLines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
      kept = rawLines.filter((l) => {
        let entry: any;
        try {
          entry = JSON.parse(l);
        } catch {
          return false; // torn line: rewriting the file removes it
        }
        return entry?.run_id !== runId;
      });
    }
    const out = [...kept, ...appended.map((e) => JSON.stringify(e))];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.length > 0 ? out.join("\n") + "\n" : "", "utf8");
  }

  return appended.length;
}

// Converts a cumulative usage report into a per-report delta against `prev`.
// With cumulative false the delta is the record as is. A negative difference
// is set to 0. The next totals are the record itself (cumulative reports
// always advance to their full value).
export function toDelta(
  prev: UsageTotals | undefined,
  record: UsageRecord,
  cumulative: boolean
): { delta: UsageRecord; next: UsageTotals } {
  if (!cumulative) {
    return {
      delta: record,
      next: {
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        cost_usd: record.cost_usd,
      },
    };
  }

  const prevTotals: UsageTotals = prev ?? {
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  const delta: UsageRecord = {
    ...record,
    input_tokens: Math.max(0, record.input_tokens - prevTotals.input_tokens),
    output_tokens: Math.max(0, record.output_tokens - prevTotals.output_tokens),
    cost_usd: Math.max(0, record.cost_usd - prevTotals.cost_usd),
  };
  return {
    delta,
    next: {
      input_tokens: record.input_tokens,
      output_tokens: record.output_tokens,
      cost_usd: record.cost_usd,
    },
  };
}

export type UsageGroupBy = "model" | "provider" | "role" | "run" | "task" | "class" | "day";

export interface UsageRow {
  group: string;
  runs: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unknown_cost_rows: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}

/**
 * Reads a usage ledger JSONL file. A missing file returns []. Blank lines are
 * ignored; lines that are not valid JSON or fail the UsageLedgerEntry schema
 * (including a torn last line) are skipped.
 */
export function readUsageLedger(file: string): UsageLedgerEntry[] {
  if (!fs.existsSync(file)) return [];

  const entries: UsageLedgerEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn or malformed line: skipped
    }
    const result = UsageLedgerEntry.safeParse(parsed);
    if (result.success) {
      entries.push(result.data);
    }
  }
  return entries;
}

// The engine numbers a task's first generation 1 (reducer.ts), so a ledger row
// with a task_id but no generation belongs to generation 1.
export const FIRST_GENERATION = 1;

export function taskGenerationKey(runId: string, taskId: string, generation: number): string {
  return `${runId}/${taskId}/${generation}`;
}

/**
 * Groups ledger rows by task generation (run_id, task_id, generation). Rows with
 * no task_id (planner and reviewer rows) are not task rows and are skipped. Order
 * inside each list is the ledger order.
 */
export function distinctTasks(entries: UsageLedgerEntry[]): Map<string, UsageLedgerEntry[]> {
  const tasks = new Map<string, UsageLedgerEntry[]>();
  for (const entry of entries) {
    if (entry.task_id === undefined) continue;
    const key = taskGenerationKey(entry.run_id, entry.task_id, entry.generation ?? FIRST_GENERATION);
    const list = tasks.get(key);
    if (list) {
      list.push(entry);
    } else {
      tasks.set(key, [entry]);
    }
  }
  return tasks;
}

function groupKey(entry: UsageLedgerEntry, by: UsageGroupBy): string {
  switch (by) {
    case "model":
      return entry.model;
    case "provider":
      return entry.backend;
    case "role":
      return entry.role;
    case "task":
      return entry.task_id ?? "(none)";
    case "run":
      return entry.run_id;
    case "class":
      return entry.class ?? "(none)";
    case "day":
      return entry.ts.slice(0, 10);
  }
}

/**
 * Groups ledger entries by one of the seven --by keys. A row is never dropped
 * because its price is unknown: unknown-cost entries count toward tokens and
 * calls and are flagged through unknown_cost_rows. Cache fields stay zero
 * unless opts.cache is set. Sorted by cost descending, then group name.
 */
export function groupUsage(
  entries: UsageLedgerEntry[],
  by: UsageGroupBy,
  opts: { cache: boolean }
): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const runIds = new Map<string, Set<string>>();

  for (const entry of entries) {
    const key = groupKey(entry, by);
    let row = rows.get(key);
    if (!row) {
      row = {
        group: key,
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
      rows.set(key, row);
      runIds.set(key, new Set());
    }
    runIds.get(key)!.add(entry.run_id);

    row.calls += 1;
    row.input_tokens += entry.input_tokens;
    row.output_tokens += entry.output_tokens;
    row.cost_usd += entry.cost_usd;
    if (entry.cost_source === "unknown") {
      row.unknown_cost_rows += 1;
    }
    if (opts.cache) {
      row.cache_read_tokens += entry.cache_read_tokens ?? 0;
      row.cache_write_tokens += entry.cache_write_tokens ?? 0;
      row.reasoning_tokens += entry.reasoning_tokens ?? 0;
    }
  }

  for (const [key, row] of rows) {
    row.runs = runIds.get(key)!.size;
  }

  return [...rows.values()].sort(
    (a, b) => b.cost_usd - a.cost_usd || a.group.localeCompare(b.group)
  );
}
