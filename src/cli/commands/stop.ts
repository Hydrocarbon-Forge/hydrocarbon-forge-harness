import { spawnSync } from "node:child_process";

import { runProcessOf } from "../../store/run-lock.js";

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
const { readRun, listRuns } = await import(`../run-observe.js`);

/** The run record fields stop reads (run-observe.ts RunRecord). */
interface RunRecord {
  runId: string;
  status: string;
}

/** How long a stop waits for the run's process to exit after SIGTERM (R10.3). */
export const STOP_WAIT_MS = 15000;
/** How long a forced stop waits for the process to disappear after SIGKILL. */
const KILL_WAIT_MS = 3000;
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the process table says about a pid: whether it is alive (a zombie has exited) and its command line. */
export function processInfoOf(pid: number): { alive: boolean; args: string } {
  const res = spawnSync("ps", ["-p", String(pid), "-o", "stat=,args="], { encoding: "utf8" });
  const line = (res.stdout ?? "").trim();
  if (res.status !== 0 || line.length === 0) return { alive: false, args: "" };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(line);
  if (match === null) return { alive: false, args: "" };
  return { alive: !match[1].startsWith("Z"), args: match[2] };
}

/** A Substrate process names `substrate` on its command line (dist/substrate.mjs, or the installed binary). */
export function isSubstrateProcess(args: string): boolean {
  return args.includes("substrate");
}

/** How a stop looks at and signals a process. The command uses the real one; a unit test injects its own. */
export interface ProcessControl {
  info(pid: number): { alive: boolean; args: string };
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
}

export const realProcessControl: ProcessControl = {
  info: processInfoOf,
  signal(pid, sig) {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone: the wait that follows sees it.
    }
  },
};

export type StopOutcome = "stopped" | "not_stopped" | "killed" | "refused";

async function waitForExit(control: ProcessControl, pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!control.info(pid).alive) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * Ends one run process (R10.3). The pid is signalled only while its command line names substrate,
 * checked before SIGTERM and again before SIGKILL, so a recycled pid is never touched. SIGTERM takes
 * the graceful path (workers killed, run paused with reason user_cancel). A process still alive
 * after `waitMs` is left running unless `force` is set, when it gets SIGKILL.
 */
export async function endRunProcess(
  pid: number,
  opts: { force: boolean; control?: ProcessControl; waitMs?: number; killWaitMs?: number },
): Promise<StopOutcome> {
  const control = opts.control ?? realProcessControl;
  const first = control.info(pid);
  if (!first.alive) return "stopped";
  if (!isSubstrateProcess(first.args)) return "refused";
  control.signal(pid, "SIGTERM");
  if (await waitForExit(control, pid, opts.waitMs ?? STOP_WAIT_MS)) return "stopped";
  if (!opts.force) return "not_stopped";
  const again = control.info(pid);
  if (!again.alive) return "stopped";
  if (!isSubstrateProcess(again.args)) return "refused";
  control.signal(pid, "SIGKILL");
  return (await waitForExit(control, pid, opts.killWaitMs ?? KILL_WAIT_MS)) ? "killed" : "not_stopped";
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
