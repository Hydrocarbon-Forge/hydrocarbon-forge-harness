import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { Effort, Engine, PermissionMode, RunId } from "../../contracts/index.js";
import { parseEngineEvent, type EngineEventV1 } from "../../contracts/events.js";
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
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
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

function readRunEvents(eventsPath: string, stderr: NodeJS.WriteStream): EngineEventV1[] {
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: EngineEventV1[] = [];
  let torn = false;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      torn = true;
      continue;
    }
    try {
      events.push(parseEngineEvent(parsed));
    } catch {
      // Not a catalog event: the CLI never reads it.
      continue;
    }
  }
  if (torn) {
    stderr.write(
      `warning: ${eventsPath} contains torn or unparsable lines; complete lines were used\n`
    );
  }
  return events;
}

export const reportCommand: CliCommand = {
  name: "report",
  description: "Generate diagnostic report for a run",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0];
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }

    const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
    const eventsPath = path.join(runDir, "events.jsonl");
    if (!fs.existsSync(runDir)) {
      ctx.stderr.write(`Error: Run '${runId}' directory not found\n`);
      return 2;
    }

    const events = readRunEvents(eventsPath, ctx.stderr);

    if (events.length === 0) {
      ctx.stdout.write(`no events recorded\n`);
      return 1;
    }

    // Goal: the first run.created data's goal, or the prompt.
    let goal = "";
    const created = events.find((e) => e.type === "run.created");
    if (created) {
      const createdData = (created.data ?? {}) as Record<string, unknown>;
      if (typeof createdData.goal === "string" && createdData.goal) {
        goal = createdData.goal;
      } else if (typeof createdData.prompt === "string" && createdData.prompt) {
        goal = createdData.prompt;
      }
    }
    if (!goal) {
      const manifestPath = path.join(runDir, "manifest.yaml");
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
          goal = manifest.goal || "";
        } catch {
          // ignore
        }
      }
    }

    // Duration: last event ts minus first.
    const firstTs = events[0] ? Date.parse(events[0].ts) : NaN;
    const lastTs = events[events.length - 1] ? Date.parse(events[events.length - 1].ts) : NaN;
    const durationMs =
      Number.isFinite(firstTs) && Number.isFinite(lastTs) ? Math.max(0, lastTs - firstTs) : 0;

    // Task states via the engine reducer.
    let state: EngineState = {
      run_id: runId as RunId,
      state: "CREATED",
      tasks: {},
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };
    for (const ev of events) {
      state = reduce(state, ev);
    }

    // Tokens and cost summed from usage.recorded records.
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    for (const ev of events) {
      if (ev.type !== "usage.recorded") continue;
      const record = ((ev.data as Record<string, unknown>).record ?? {}) as Record<string, unknown>;
      tokensIn += Number(record.input_tokens ?? 0);
      tokensOut += Number(record.output_tokens ?? 0);
      costUsd += Number(record.cost_usd ?? 0);
    }

    // Files changed: reported by the engine in run.finished data when known.
    const filesChanged: string[] = [];
    for (const ev of events) {
      if (ev.type !== "run.finished") continue;
      const data = (ev.data ?? {}) as Record<string, unknown>;
      if (Array.isArray(data.files)) {
        for (const f of data.files) {
          if (typeof f === "string" && !filesChanged.includes(f)) filesChanged.push(f);
        }
      }
    }

    ctx.stdout.write(`=== Diagnostic Report for Run ${runId} ===\n\n`);
    ctx.stdout.write(`Goal: ${goal || "Unknown"}\n`);
    ctx.stdout.write(`Duration: ${(durationMs / 1000).toFixed(1)}s\n\n`);

    ctx.stdout.write(`Tasks:\n`);
    ctx.stdout.write(`ID\tState\tGen\tAttempts\tFailure\n`);
    ctx.stdout.write(`------------------------------------------------\n`);
    const taskEntries = Object.values(state.tasks).sort((a, b) => a.id.localeCompare(b.id));
    for (const t of taskEntries) {
      ctx.stdout.write(
        `${t.id}\t${t.state}\t${t.generation}\t${t.attempt}\t${t.failure_class ?? "-"}\n`
      );
    }
    ctx.stdout.write(`\n`);

    ctx.stdout.write(`Tokens In:  ${tokensIn}\n`);
    ctx.stdout.write(`Tokens Out: ${tokensOut}\n`);
    ctx.stdout.write(`Cost:       $${costUsd.toFixed(2)}\n\n`);

    ctx.stdout.write(`Files Changed:\n`);
    if (filesChanged.length === 0) {
      ctx.stdout.write(`  (none recorded)\n`);
    } else {
      for (const f of filesChanged) {
        ctx.stdout.write(`  ${f}\n`);
      }
    }
    ctx.stdout.write(`\n`);

    ctx.stdout.write(`Verify Outcomes:\n`);
    const verifyEvents = events.filter((e) => e.type === "task.verify.finished");
    if (verifyEvents.length === 0) {
      ctx.stdout.write(`  (none)\n`);
    } else {
      for (const ev of verifyEvents) {
        const data = (ev.data ?? {}) as Record<string, unknown>;
        ctx.stdout.write(
          `  task ${data.task_id ?? "-"}: ${data.passed === true ? "passed" : "failed"} (gen ${data.generation ?? "-"}, attempt ${data.attempt ?? "-"})\n`
        );
      }
    }

    return 0;
  },
};

registry.register(reportCommand);
