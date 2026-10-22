import { runProcessOf } from "../../store/run-lock.js";
import { endRunProcess, isSubstrateProcess, realProcessControl, STOP_WAIT_MS } from "../../util/process-control.js";

// The command shape every command file declares for itself (see status.ts): cli modules are not imported.
interface CommandContext {
  cwd: string;
  flags: { outputFormat?: "text" | "json" | "stream-json"; force?: boolean };
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
const { readRun, listRuns } = await import(`../../observe/run-observe.js`);

/** The run record fields stop reads (run-observe.ts RunRecord). */
interface RunRecord {
  runId: string;
  status: string;
}

/** The resume line a stopped or paused run is continued with. */
function resumeCommandOf(runId: string): string {
  return `substrate resume ${runId}`;
}

/**
 * `substrate stop [--force] [run-id]` (R10.3). Ends a running run from any terminal: SIGTERM to the
 * run's process, which takes the same graceful path as Ctrl+C (its workers are killed, the run is
 * paused with reason user_cancel and can be resumed). The pid comes from the run's lock. Without a
 * run id, the one running run of the project is stopped; two or more are refused.
 */
export const stopCommand: CliCommand = {
  name: "stop",
  description: "Stop a running run from another terminal; resume it later with substrate resume",
  async execute(ctx: CommandContext): Promise<number> {
    const json = ctx.flags.outputFormat === "json";
    const emit = (payload: Record<string, unknown>): void => {
      ctx.stdout.write(JSON.stringify(payload) + "\n");
    };

    let record: RunRecord | undefined;
    if (ctx.rawArgs.length > 0) {
      record = readRun(ctx.cwd, ctx.rawArgs[0]);
      if (record === undefined) {
        ctx.stderr.write(`No such run: ${ctx.rawArgs[0]}\n`);
        return 2;
      }
    } else {
      const live = listRuns(ctx.cwd).filter((r) => runProcessOf(ctx.cwd, r.runId)?.alive === true);
      if (live.length > 1) {
        const lines = live.map((r) => `  ${r.runId} (pid ${runProcessOf(ctx.cwd, r.runId)?.pid})`);
        ctx.stderr.write(
          `${live.length} runs are running in this project; name the one to stop:\n${lines.join("\n")}\n` +
            `use: substrate stop <run-id>\n`,
        );
        return 2;
      }
      if (live.length === 0) {
        if (json) emit({ run_id: null, stopped: false, pid: null, next: null });
        else ctx.stdout.write("no run is running in this project\n");
        return 0;
      }
      record = live[0];
    }

    const runId = record.runId;
    const proc = runProcessOf(ctx.cwd, runId);
    if (proc === undefined || !proc.alive) {
      // Not running: a run that ended names its state; an unclean stop is resumed.
      const ended = record.status === "finished" || record.status === "failed" || record.status === "cancelled";
      const next = ended ? null : resumeCommandOf(runId);
      if (json) {
        emit({ run_id: runId, stopped: false, pid: proc?.pid ?? null, next });
      } else if (ended) {
        ctx.stdout.write(`run ${runId} is not running (it ended ${record.status})\n`);
      } else {
        ctx.stdout.write(`run ${runId} is not running (stopped). Resume with: ${next}\n`);
      }
      return 0;
    }

    const pid = proc.pid;
    if (!isSubstrateProcess(realProcessControl.info(pid).args)) {
      ctx.stderr.write(`pid ${pid} is not a Substrate process (stale lock); not signalling it\n`);
      return 1;
    }

    if (!json) ctx.stdout.write(`stopping run ${runId} (pid ${pid})...\n`);
    const outcome = await endRunProcess(pid, { force: ctx.flags.force === true });
    if (outcome === "refused") {
      ctx.stderr.write(`pid ${pid} is not a Substrate process (stale lock); not signalling it\n`);
      return 1;
    }
    if (outcome === "stopped" || outcome === "killed") {
      const note = outcome === "killed"
        ? `killed (pid ${pid}); the workers recorded under the run are cleaned up by the next resume`
        : "stopped";
      if (json) emit({ run_id: runId, stopped: true, pid, next: resumeCommandOf(runId) });
      else ctx.stdout.write(`run ${runId} ${note}. Resume with: ${resumeCommandOf(runId)}\n`);
      return 0;
    }
    ctx.stderr.write(
      `run ${runId} did not stop within ${STOP_WAIT_MS / 1000} s; use: substrate stop --force ${runId}\n`,
    );
    if (json) emit({ run_id: runId, stopped: false, pid, next: `substrate stop --force ${runId}` });
    return 1;
  },
};

registry.register(stopCommand);
