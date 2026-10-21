import fs from "node:fs";

import type { EngineEvent, RunId } from "../../contracts/index.js";
import { EventStoreImpl } from "../../store/event-store.js";
import { runProcessOf } from "../../store/run-lock.js";


// The command shape every command file declares for itself (see status.ts): cli modules are not imported.
interface CommandContext {
  cwd: string;
  flags: { outputFormat?: "text" | "json" | "stream-json"; noFollow?: boolean };
  rawArgs: string[];
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

interface CliCommand {
  name: string;
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);
const { heartbeatMsFromEnv, progressLine } = await import(`../progress.js`);
const { exitCodeOf, isTerminalState, listRuns, logMarksOf, modelsOf, recordOf, RunReplay, summaryTextOf } =
  await import(`../run-observe.js`);
const { runDirOf } = await import(`../run-files.js`);

/** How often a following watch reads the journal again. */
const POLL_MS = 500;

/**
 * Once a run's state is terminal, its process may still be landing the work and writing its
 * outcome. This is how long a watch waits for that outcome after the process has gone (R10.2).
 */
const OUTCOME_GRACE_MS = 3000;

function readEvents(runDir: string, runId: string): EngineEvent[] {
  return new EventStoreImpl(runId as RunId, { runDir }).readAllSync();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `substrate watch [run-id]` (R10.2). Prints a run's history from its journal, rendered with the
 * renderer a live run uses, then follows new events until the run reaches a terminal state, prints
 * its summary and exits with the run's exit code. It takes no lock and writes nothing: it reads
 * events.jsonl, the run's lock file, its progress.log and its outcome files.
 */
export const watchCommand: CliCommand = {
  name: "watch",
  description: "Follow a run's progress from another terminal: its history, then new events",
  async execute(ctx: CommandContext): Promise<number> {
    const format = ctx.flags.outputFormat ?? "text";
    if (format === "json") {
      ctx.stderr.write("Error: watch prints text or stream-json; use substrate status --output-format json\n");
      return 2;
    }

    // The run to watch: the named one, else the newest running run, else the newest run.
    let runId = ctx.rawArgs[0];
    if (runId === undefined) {
      const runs = listRuns(ctx.cwd);
      const pick = runs.find((r) => r.status === "running") ?? runs[0];
      if (pick === undefined) {
        ctx.stderr.write("No such run: this project has no runs\n");
        return 2;
      }
      runId = pick.runId;
    }
    const runDir = runDirOf(ctx.cwd, runId);
    if (!fs.existsSync(`${runDir}/events.jsonl`)) {
      ctx.stderr.write(`No such run: ${runId}\n`);
      return 2;
    }

    const text = format === "text";
    const out = ctx.stdout;
    let events: EngineEvent[];
    try {
      events = readEvents(runDir, runId);
    } catch (err: any) {
      ctx.stderr.write(`Error: ${err?.message ?? err}\n`);
      return 2;
    }
    const replay = new RunReplay(await modelsOf(ctx.cwd, events), runId);
    const heartbeatMs = heartbeatMsFromEnv();

    // The progress log's `# run` header opens the output; its `# resumed` lines come in time order.
    const printedMarks = new Set<string>();
    const printMarks = (before: number | undefined): void => {
      for (const mark of logMarksOf(runDir)) {
        if (printedMarks.has(mark.text)) continue;
        const opensRun = mark.text.startsWith("# run ");
        if (!opensRun && (before === undefined || mark.at > before)) continue;
        if (text) out.write(`${mark.text}\n`);
        printedMarks.add(mark.text);
      }
    };

    let fed = 0;
    let lastPrintedAt = Date.now();
    const feedNew = (): void => {
      while (fed < events.length) {
        const ev = events[fed];
        printMarks(Date.parse(ev.ts));
        const lines = replay.feed(ev);
        if (text) {
          for (const line of lines) out.write(line);
          if (lines.length > 0) lastPrintedAt = Date.now();
        } else {
          out.write(JSON.stringify(ev) + "\n");
        }
        fed++;
      }
      printMarks(undefined);
    };

    feedNew();
    // --no-follow: the history, and nothing more (R10.2).
    if (ctx.flags.noFollow === true) return 0;

    let goneSince: number | undefined;
    for (;;) {
      const alive = runProcessOf(ctx.cwd, runId)?.alive === true;
      if (isTerminalState(replay.state.state)) {
        if (alive) {
          goneSince = undefined;
        } else {
          goneSince ??= Date.now();
          const record = recordOf(ctx.cwd, runId, events);
          const outcomeWritten = fs.existsSync(`${runDir}/result.json`)
            && record.lastEventAt !== undefined
            && fs.statSync(`${runDir}/result.json`).mtimeMs >= record.lastEventAt;
          if (outcomeWritten || Date.now() - goneSince >= OUTCOME_GRACE_MS) {
            if (text) out.write(await summaryTextOf(ctx.cwd, record));
            return exitCodeOf(record);
          }
        }
      } else if (!alive) {
        // The process that started the run has gone, so nothing more will be written (R10.2).
        ctx.stderr.write(
          `run ${runId} is not running (the process that started it has gone). Resume with: substrate resume ${runId}\n`,
        );
        return 1;
      }

      await sleep(POLL_MS);
      try {
        events = readEvents(runDir, runId);
      } catch (err: any) {
        ctx.stderr.write(`Error: ${err?.message ?? err}\n`);
        return 2;
      }
      feedNew();

      // A heartbeat once nothing has been printed for a while, as a live run writes one (R10.2).
      const progress = replay.progress;
      if (text && progress !== undefined && !isTerminalState(replay.state.state) && Date.now() - lastPrintedAt >= heartbeatMs) {
        const now = Date.now();
        out.write(progressLine(progress.heartbeatText(now), now, progress.startedAt));
        lastPrintedAt = now;
      }
    }
  },
};

registry.register(watchCommand);
