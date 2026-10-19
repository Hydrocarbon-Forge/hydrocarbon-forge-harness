import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { RunId } from "../contracts/index.js";
import { parseEngineEvent, type EngineEventV1 } from "../contracts/events.js";
import { reduce, type EngineState } from "../engine/reducer.js";

export interface ArchiveRecord {
  run_id: string;
  status: string;
  goal: string;
  ended_at: string;
  dir: string;
}

export interface ArchiveUsage {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_source_unknown_rows: number;
  by_role: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;
}

function resolveSubstrateDir(dir: string): string {
  if (path.basename(dir) === ".substrate") {
    return dir;
  }
  const sub = path.join(dir, ".substrate");
  if (fs.existsSync(sub)) {
    return sub;
  }
  return dir;
}

/**
 * Returns the version string from the frontmatter of .substrate/charter.md when present,
 * otherwise "v1".
 */
export function currentVersion(substrateDir: string): string {
  const base = resolveSubstrateDir(substrateDir);
  const charterPath = path.join(base, "charter.md");

  if (!fs.existsSync(charterPath)) {
    return "v1";
  }

  try {
    const content = fs.readFileSync(charterPath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const parsed = YAML.parse(match[1]);
      if (parsed && typeof parsed === "object" && parsed.version !== undefined) {
        return String(parsed.version).trim() || "v1";
      }
    }
  } catch {
    // on parse failure fallback to v1
  }

  return "v1";
}

function readRunEvents(eventsPath: string): EngineEventV1[] {
  if (!fs.existsSync(eventsPath)) return [];
  try {
    const content = fs.readFileSync(eventsPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const events: EngineEventV1[] = [];
    for (const line of lines) {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        events.push(parseEngineEvent(parsed));
      } catch {
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
          events.push(parsed);
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}

function computeUsage(repoRoot: string, runId: string, runDir: string): ArchiveUsage {
  const usage: ArchiveUsage = {
    run_id: runId,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_source_unknown_rows: 0,
    by_role: {},
  };

  const projectLedger = path.join(repoRoot, ".substrate", "ledger", "usage.jsonl");
  let foundLedgerRows = false;

  if (fs.existsSync(projectLedger)) {
    try {
      const lines = fs.readFileSync(projectLedger, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.run_id === runId) {
          foundLedgerRows = true;
          const input = Number(entry.input_tokens ?? 0);
          const output = Number(entry.output_tokens ?? 0);
          const cost = Number(entry.cost_usd ?? 0);
          const unknown = entry.cost_source === "unknown" ? 1 : 0;
          const role = entry.role ?? "worker";

          usage.input_tokens += input;
          usage.output_tokens += output;
          usage.cost_usd += cost;
          usage.cost_source_unknown_rows += unknown;

          usage.by_role[role] = usage.by_role[role] ?? {
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
          };
          usage.by_role[role].input_tokens += input;
          usage.by_role[role].output_tokens += output;
          usage.by_role[role].cost_usd += cost;
        }
      }
    } catch {
      // ignore
    }
  }

  if (!foundLedgerRows) {
    const eventsPath = path.join(runDir, "events.jsonl");
    const events = readRunEvents(eventsPath);
    for (const ev of events) {
      if (ev.type === "usage.recorded") {
        const data = (ev.data ?? {}) as Record<string, any>;
        const record = data.record ?? {};
        const input = Number(record.input_tokens ?? 0);
        const output = Number(record.output_tokens ?? 0);
        const cost = Number(record.cost_usd ?? 0);
        const unknown = record.cost_source === "unknown" ? 1 : 0;
        const role = data.role ?? "worker";

        usage.input_tokens += input;
        usage.output_tokens += output;
        usage.cost_usd += cost;
        usage.cost_source_unknown_rows += unknown;

        usage.by_role[role] = usage.by_role[role] ?? {
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
        };
        usage.by_role[role].input_tokens += input;
        usage.by_role[role].output_tokens += output;
        usage.by_role[role].cost_usd += cost;
      }
    }
  }

  return usage;
}

export function archiveSummary(record: ArchiveRecord, runDir: string): string {
  const eventsPath = path.join(runDir, "events.jsonl");
  const events = readRunEvents(eventsPath);

  let state: EngineState = {
    run_id: record.run_id as RunId,
    state: "CREATED",
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
  for (const ev of events) {
    state = reduce(state, ev);
  }

  let exitCode = 0;
  const finishEv = [...events].reverse().find((e) => e.type === "run.finished");
  if (finishEv && (finishEv.data as any)?.exit_code !== undefined) {
    exitCode = Number((finishEv.data as any).exit_code);
  } else if (record.status === "failed") {
    exitCode = 1;
  } else if (record.status === "cancelled") {
    exitCode = 1;
  }

  // Tasks table
  const taskEntries = Object.values(state.tasks).sort((a, b) => a.id.localeCompare(b.id));
  let tasksSection = "(none)";
  if (taskEntries.length > 0) {
    const rows = [
      "| ID | State | Generation | Failure Class |",
      "| --- | --- | --- | --- |",
    ];
    for (const t of taskEntries) {
      const failureClass = t.failure_class ?? "-";
      rows.push(`| ${t.id} | ${t.state} | ${t.generation ?? 1} | ${failureClass} |`);
    }
    tasksSection = rows.join("\n");
  }

  // Decisions / what was learned: first 20 lines of decisions.md
  let whatWasLearned = "(none)";
  const decisionsPath = path.join(runDir, "decisions.md");
  if (fs.existsSync(decisionsPath)) {
    try {
      const content = fs.readFileSync(decisionsPath, "utf8").trim();
      if (content.length > 0) {
        const lines = content.split("\n").slice(0, 20);
        whatWasLearned = lines.join("\n");
      }
    } catch {
      // ignore
    }
  }

  // Usage: input/output tokens, cost, unknown rows
  let usage: ArchiveUsage;
  const archiveUsageFile = path.join(record.dir, "usage.json");
  if (fs.existsSync(archiveUsageFile)) {
    try {
      usage = JSON.parse(fs.readFileSync(archiveUsageFile, "utf8"));
    } catch {
      const repoRoot = path.resolve(runDir, "..", "..");
      usage = computeUsage(repoRoot, record.run_id, runDir);
    }
  } else {
    const repoRoot = path.resolve(runDir, "..", "..");
    usage = computeUsage(repoRoot, record.run_id, runDir);
  }

  const sections = [
    `## Goal\n\n${record.goal || "(none)"}`,
    `## Outcome\n\n- Status: ${record.status}\n- Exit code: ${exitCode}`,
    `## Tasks\n\n${tasksSection}`,
    `## Usage\n\n- Input tokens: ${usage.input_tokens}\n- Output tokens: ${usage.output_tokens}\n- Cost: $${usage.cost_usd.toFixed(4)}\n- Unknown rows: ${usage.cost_source_unknown_rows}`,
    `## What was learned\n\n${whatWasLearned}`,
  ];

  return sections.join("\n\n") + "\n";
}

export function readIndex(substrateDir: string, version: string): ArchiveRecord[] {
  const base = resolveSubstrateDir(substrateDir);
  const indexPath = path.join(base, "archive", version, "INDEX.md");

  if (!fs.existsSync(indexPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(indexPath, "utf8");
    const lines = content.split("\n");
    const records: ArchiveRecord[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) continue;
      const raw = trimmed.slice(2);
      const parts = raw.split(" | ");
      if (parts.length >= 4) {
        const run_id = parts[0].trim();
        const status = parts[1].trim();
        const ended_at = parts[parts.length - 1].trim();
        const goal = parts.slice(2, parts.length - 1).join(" | ").trim();
        const dir = path.join(base, "archive", version, run_id);
        records.push({
          run_id,
          status,
          goal,
          ended_at,
          dir,
        });
      }
    }

    return records;
  } catch {
    return [];
  }
}

export async function archiveRun(opts: {
  repoRoot: string;
  runId: RunId;
  runDir: string;
  version?: string;
}): Promise<ArchiveRecord> {
  const substrateDir = path.join(opts.repoRoot, ".substrate");
  const version = opts.version ?? currentVersion(substrateDir);
  const archiveDir = path.join(substrateDir, "archive", version, opts.runId);

  fs.mkdirSync(archiveDir, { recursive: true });

  const eventsPath = path.join(opts.runDir, "events.jsonl");
  const events = readRunEvents(eventsPath);

  let goal = "";
  const createdEv = events.find((e) => e.type === "run.created");
  if (createdEv) {
    const data = (createdEv.data ?? {}) as Record<string, unknown>;
    if (typeof data.goal === "string" && data.goal) {
      goal = data.goal;
    } else if (typeof data.prompt === "string" && data.prompt) {
      goal = data.prompt;
    }
  }

  const manifestPath = path.join(opts.runDir, "manifest.yaml");
  if (!goal && fs.existsSync(manifestPath)) {
    try {
      const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest?.goal) goal = manifest.goal;
    } catch {
      // ignore
    }
  }

  let status = "finished";
  let ended_at = new Date().toISOString();

  if (events.length > 0) {
    ended_at = events[events.length - 1].ts;
    const finishEv = [...events].reverse().find((e) => e.type === "run.finished");
    if (finishEv) {
      ended_at = finishEv.ts;
      const data = (finishEv.data ?? {}) as Record<string, unknown>;
      if (typeof data.status === "string" && data.status) {
        status = data.status;
      } else if (data.exit_code === 0) {
        status = "finished";
      } else {
        status = "failed";
      }
    } else {
      const pausedEv = [...events].reverse().find((e) => e.type === "run.paused");
      if (pausedEv && (pausedEv.data as any)?.reason === "user_cancel") {
        status = "cancelled";
      }
    }
  }

  const record: ArchiveRecord = {
    run_id: opts.runId,
    status,
    goal,
    ended_at,
    dir: archiveDir,
  };

  // 1. manifest.yaml
  if (fs.existsSync(manifestPath)) {
    fs.copyFileSync(manifestPath, path.join(archiveDir, "manifest.yaml"));
  } else {
    const soloManifest = {
      run_id: opts.runId,
      mode: "solo",
      status: record.status,
    };
    fs.writeFileSync(
      path.join(archiveDir, "manifest.yaml"),
      YAML.stringify(soloManifest),
      "utf8"
    );
  }

  // 2. tasks/
  const archiveTasksDir = path.join(archiveDir, "tasks");
  fs.mkdirSync(archiveTasksDir, { recursive: true });

  const runTasksDir = path.join(opts.runDir, "tasks");
  if (fs.existsSync(runTasksDir)) {
    for (const file of fs.readdirSync(runTasksDir)) {
      if (file.endsWith(".md")) {
        fs.copyFileSync(path.join(runTasksDir, file), path.join(archiveTasksDir, file));
      }
    }
  }

  const runPacketsDir = path.join(opts.runDir, "packets");
  if (fs.existsSync(runPacketsDir)) {
    for (const file of fs.readdirSync(runPacketsDir)) {
      if (file.endsWith(".json")) {
        fs.copyFileSync(path.join(runPacketsDir, file), path.join(archiveTasksDir, file));
      }
    }
  }

  // 3. decisions.md
  const decisionsPath = path.join(opts.runDir, "decisions.md");
  if (fs.existsSync(decisionsPath)) {
    fs.copyFileSync(decisionsPath, path.join(archiveDir, "decisions.md"));
  } else {
    fs.writeFileSync(
      path.join(archiveDir, "decisions.md"),
      "no decisions.md was written by the planner\n",
      "utf8"
    );
  }

  // 4. usage.json
  const usage = computeUsage(opts.repoRoot, opts.runId, opts.runDir);
  fs.writeFileSync(
    path.join(archiveDir, "usage.json"),
    JSON.stringify(usage, null, 2) + "\n",
    "utf8"
  );

  // 5. summary.md
  const summary = archiveSummary(record, opts.runDir);
  fs.writeFileSync(path.join(archiveDir, "summary.md"), summary, "utf8");

  // 6. Updates .substrate/archive/<version>/INDEX.md
  const indexPath = path.join(substrateDir, "archive", version, "INDEX.md");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });

  const cleanGoal = record.goal.replace(/\r?\n/g, " ").trim().slice(0, 80);
  const indexLine = `- ${record.run_id} | ${record.status} | ${cleanGoal} | ${record.ended_at}`;

  let existingLines: string[] = [];
  if (fs.existsSync(indexPath)) {
    existingLines = fs
      .readFileSync(indexPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
  }

  const prefix = `- ${record.run_id} |`;
  const existingIdx = existingLines.findIndex((l) => l.trim().startsWith(prefix));

  if (existingIdx !== -1) {
    existingLines[existingIdx] = indexLine;
    // remove any duplicate occurrences of the same run_id
    existingLines = existingLines.filter(
      (l, idx) => idx === existingIdx || !l.trim().startsWith(prefix)
    );
  } else {
    existingLines.push(indexLine);
  }

  fs.writeFileSync(indexPath, existingLines.join("\n") + "\n", "utf8");

  return record;
}
