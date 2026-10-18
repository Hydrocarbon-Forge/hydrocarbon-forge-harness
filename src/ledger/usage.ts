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
