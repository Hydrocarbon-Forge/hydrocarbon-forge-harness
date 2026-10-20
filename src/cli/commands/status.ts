import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode, Question, RunId } from "../../contracts/index.js";
import { parseEngineEvent } from "../../contracts/events.js";
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

export function isPassedState(state: string): boolean {
  return state === "PASSED" || state === "MERGED";
}

// Reads a run's events.jsonl through the catalog types only. Complete lines
// that are not catalog events are skipped; a torn final line (partial write)
// is ignored with a warning on stderr.
export function readCatalogEvents(
  eventsPath: string,
  stderr: NodeJS.WriteStream
): ReturnType<typeof parseEngineEvent>[] {
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: ReturnType<typeof parseEngineEvent>[] = [];
  let warned = false;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warned = true;
      continue;
    }
    try {
      events.push(parseEngineEvent(parsed));
    } catch {
      // Not a catalog event: the CLI never reads it.
      continue;
    }
  }
  if (warned) {
    stderr.write(
      `warning: ${eventsPath} contains torn or unparsable lines; complete lines were used\n`
    );
  }
  return events;
}

export function reduceRunEvents(eventsPath: string, stderr: NodeJS.WriteStream): {
  state: EngineState;
  events: ReturnType<typeof parseEngineEvent>[];
} {
  const events = readCatalogEvents(eventsPath, stderr);
  let state: EngineState = {
    run_id: "" as RunId,
    state: "CREATED",
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
  for (const ev of events) {
    state = reduce(state, ev);
  }
  return { state, events };
}

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

    const { state, events } = reduceRunEvents(eventsFile, ctx.stderr);

    let pendingQuestions: Question[] | undefined;
    const questionsFile = path.join(runDir, "QUESTIONS.md");
    if (state.state === "PAUSED" && state.pause_reason === "needs_human" && fs.existsSync(questionsFile)) {
      const lastPausedIdx = events.map((e) => e.type).lastIndexOf("run.paused");
      const resumedAfterWithAnswers = events
        .slice(lastPausedIdx + 1)
        .some((e) => e.type === "run.resumed" && (e.data as any)?.answers !== undefined);
      if (!resumedAfterWithAnswers) {
        const { parseQuestions } = await import(`../questions.js`);
        pendingQuestions = parseQuestions(fs.readFileSync(questionsFile, "utf8"));
      }
    }

    const taskEntries = Object.entries(state.tasks);
    const taskCount = taskEntries.length;
    const passedCount = taskEntries.filter(([, t]) => isPassedState(t.state)).length;

    if (ctx.flags.outputFormat === "json") {
      const payload = {
        run_id: state.run_id || targetRunId,
        state: state.state,
        pause_reason: state.pause_reason,
        ...(pendingQuestions ? { questions: pendingQuestions } : {}),
        passed: passedCount,
        total: taskCount,
        tasks: Object.fromEntries(
          taskEntries.map(([id, t]) => [
            id,
            {
              state: t.state,
              generation: t.generation,
              attempt: t.attempt,
              failure_class: t.failure_class,
            },
          ])
        ),
        usage: state.usage,
      };
      ctx.stdout.write(JSON.stringify(payload) + "\n");
      return 0;
    }

    ctx.stdout.write(`=== Run Status ===\n`);
    ctx.stdout.write(`Run ID:      ${state.run_id || targetRunId}\n`);
    ctx.stdout.write(`State:       ${state.state}\n`);
    if (state.pause_reason) {
      ctx.stdout.write(`Pause Reason: ${state.pause_reason}\n`);
    }
    ctx.stdout.write(`Tasks:       ${passedCount}/${taskCount} passed\n`);
    ctx.stdout.write(`Total Cost:  $${state.usage.total_usd.toFixed(2)}\n`);

    if (pendingQuestions && pendingQuestions.length > 0) {
      ctx.stdout.write(`\nPending Questions:\n`);
      for (const q of pendingQuestions) {
        const defStr = q.default !== undefined ? ` (default: ${q.default})` : "";
        ctx.stdout.write(`  [${q.id}] ${q.text}${defStr}\n`);
      }
    }

    if (taskCount > 0) {
      ctx.stdout.write(`\nID\tState\tGen\tAtt\tFailure\n`);
      ctx.stdout.write(`------------------------------------------------\n`);
      for (const [id, t] of taskEntries) {
        ctx.stdout.write(
          `${id}\t${t.state}\t${t.generation}\t${t.attempt}\t${t.failure_class ?? "-"}\n`
        );
      }
    }

    return 0;
  },
};

registry.register(statusCommand);
