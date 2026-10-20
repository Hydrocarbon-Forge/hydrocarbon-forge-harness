import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode, RunId } from "../../contracts/index.js";
import { parseEngineEvent } from "../../contracts/events.js";
import { reduce, type EngineState } from "../../engine/reducer.js";
import type { SessionStore } from "../../store/sessions.js";
import { archiveRun, currentVersion } from "../../archive/index.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  run?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
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

export const archiveCommand: CliCommand = {
  name: "archive",
  description: "Archive a finished run into .substrate/archive/<version>/<run_id>/",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0] || ctx.flags.run;
    if (!runId) {
      ctx.stderr.write("Error: run ID required\n");
      return 2;
    }

    const runsDir = path.join(ctx.cwd, ".substrate", "runs");
    const runDir = path.join(runsDir, runId);

    if (!fs.existsSync(runDir)) {
      ctx.stderr.write(`Error: run ${runId} not found\n`);
      return 2;
    }

    const eventsPath = path.join(runDir, "events.jsonl");
    if (!fs.existsSync(eventsPath)) {
      ctx.stderr.write(`Error: run ${runId} is not terminal\n`);
      return 1;
    }

    let events: any[] = [];
    try {
      const content = fs.readFileSync(eventsPath, "utf8");
      events = content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return parseEngineEvent(JSON.parse(l));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      ctx.stderr.write(`Error: run ${runId} is not terminal\n`);
      return 1;
    }

    if (events.length === 0) {
      ctx.stderr.write(`Error: run ${runId} is not terminal\n`);
      return 1;
    }

    let state: EngineState = {
      run_id: runId as RunId,
      state: "CREATED",
      tasks: {},
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };
    for (const ev of events) {
      state = reduce(state, ev);
      if (ev.type === "run.finished") {
        state = {
          ...state,
          state: (ev.data as any)?.exit_code === 0 ? "FINISHED" : "FAILED",
        };
      }
    }

    const isTerminal =
      state.state === "FINISHED" || state.state === "FAILED" || state.state === "CANCELLED";

    if (!isTerminal) {
      ctx.stderr.write(`Error: run ${runId} is not terminal\n`);
      return 1;
    }

    const version = currentVersion(path.join(ctx.cwd, ".substrate"));
    const record = await archiveRun({
      repoRoot: ctx.cwd,
      runId: runId as RunId,
      runDir,
      version,
    });

    ctx.stdout.write(`archived run ${runId} to ${record.dir}\n`);
    return 0;
  },
};

registry.register(archiveCommand);
