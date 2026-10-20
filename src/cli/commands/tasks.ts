import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode, TaskId } from "../../contracts/index.js";
import type { EngineState } from "../../engine/reducer.js";
import type { EngineEventV1 } from "../../contracts/events.js";
import type { SessionStore } from "../../store/sessions.js";

type ReduceRunEventsFn = (
  eventsPath: string,
  stderr: NodeJS.WriteStream
) => {
  state: EngineState;
  events: EngineEventV1[];
};

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
const { reduceRunEvents } = (await import(`./status.js`)) as unknown as {
  reduceRunEvents: ReduceRunEventsFn;
};

export const tasksCommand: CliCommand = {
  name: "tasks",
  description: "Display table of tasks for a run",
  async execute(ctx: CommandContext): Promise<number> {
    const runsDir = path.join(ctx.cwd, ".substrate", "runs");
    let targetRunId = ctx.rawArgs[0];

    if (!targetRunId) {
      if (!fs.existsSync(runsDir)) {
        ctx.stderr.write("Error: No runs directory found\n");
        return 2;
      }
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
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.mtime - a.mtime);
        targetRunId = candidates[0].id;
      }
    }

    if (!targetRunId) {
      ctx.stderr.write("Error: Run ID required or no prior runs exist\n");
      return 2;
    }

    const runDir = path.join(runsDir, targetRunId);
    const eventsFile = path.join(runDir, "events.jsonl");

    if (!fs.existsSync(eventsFile)) {
      ctx.stderr.write(`Error: Run '${targetRunId}' not found at ${eventsFile}\n`);
      return 2;
    }

    // Task states come from replaying the catalog event log through the same
    // reducer the engine uses, so every real state is shown.
    const { state } = reduceRunEvents(eventsFile, ctx.stderr);
    const taskEntries = Object.values(state.tasks).sort((a, b) =>
      a.id.localeCompare(b.id)
    );

    ctx.stdout.write(`Tasks for Run ${targetRunId}:\n\n`);
    ctx.stdout.write(`ID\tState\tGen\tAtt\tFailure\tVerdict\n`);
    ctx.stdout.write(`----------------------------------------------------------------\n`);
    for (const t of taskEntries) {
      const verdict =
        t.state === "MERGED" || t.state === "PASSED"
          ? "pass"
          : t.state === "FAILED"
            ? "fail"
            : "-";
      ctx.stdout.write(
        `${t.id}\t${t.state}\t${t.generation}\t${t.attempt}\t${t.failure_class ?? "-"}\t${verdict}\n`
      );
    }

    return 0;
  },
};

registry.register(tasksCommand);
