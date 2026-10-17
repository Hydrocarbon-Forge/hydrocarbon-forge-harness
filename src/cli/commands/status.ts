import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode, RunId } from "../../contracts/index.js";
import { reduce, type EngineState } from "../../engine/reducer.js";
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

function findLatestRunId(runsDir: string): string | null {
  if (!fs.existsSync(runsDir)) return null;
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const candidates: { id: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("r_")) {
      const full = path.join(runsDir, entry.name);
      try {
        const stat = fs.statSync(full);
        candidates.push({ id: entry.name, mtime: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].id;
}

export const statusCommand: CliCommand = {
  name: "status",
  description: "Display status and telemetry of current or specified run",
  async execute(ctx: CommandContext): Promise<number> {
    const runsDir = path.join(ctx.cwd, ".substrate", "runs");
    const targetRunId = ctx.rawArgs[0] || findLatestRunId(runsDir);

    if (!targetRunId) {
      ctx.stderr.write("Error: No run found to display status\n");
      return 2;
    }

    const runDir = path.join(runsDir, targetRunId);
    const eventsFile = path.join(runDir, "events.jsonl");

    if (!fs.existsSync(eventsFile)) {
      ctx.stderr.write(`Error: Run '${targetRunId}' not found at ${eventsFile}\n`);
      return 2;
    }

    const content = fs.readFileSync(eventsFile, "utf8");
    const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);

    let state: EngineState = {
      run_id: targetRunId as RunId,
      state: "CREATED",
      tasks: {},
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };

    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        state = reduce(state, ev);
      } catch {
        // ignore malformed
      }
    }

    const taskCount = Object.keys(state.tasks).length;
    const passedCount = Object.values(state.tasks).filter((t) => t.state === "PASSED" || (t as any).state === "verified").length;

    ctx.stdout.write(`=== Run Status ===\n`);
    ctx.stdout.write(`Run ID:      ${state.run_id}\n`);
    ctx.stdout.write(`State:       ${state.state}\n`);
    if (state.pause_reason) {
      ctx.stdout.write(`Pause Reason: ${state.pause_reason}\n`);
    }
    ctx.stdout.write(`Tasks:       ${passedCount}/${taskCount} passed\n`);
    ctx.stdout.write(`Total Cost:  $${state.usage.total_usd.toFixed(2)}\n`);

    return 0;
  },
};

registry.register(statusCommand);
