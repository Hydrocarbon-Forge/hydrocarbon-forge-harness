import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Process control for a run's process, shared by the CLI (`run --detach`, `resume --detach`, `stop`) and the web
// server (stop and resume from the browser, docs/design/web-ui.md section 5.2). Nothing here reads the CLI's
// arguments or writes to the process's own streams: a caller passes the text sinks it wants written to.

/** How long a detached start waits for the child's run to take its lock. */
export const DETACH_WAIT_MS = 30000;
const POLL_MS = 100;
const TAIL_LINES = 40;

/** How long a stop waits for the run's process to exit after SIGTERM (R10.3). */
export const STOP_WAIT_MS = 15000;
/** How long a forced stop waits for the process to disappear after SIGKILL. */
const KILL_WAIT_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Anything text is written to: a process stream, or a caller's own sink. */
export interface TextSink {
  write(text: string): unknown;
}

/** The run whose lock names this pid (`.substrate/state/<run-id>.lock`), read without taking the lock. */
export function runIdOfLockPid(cwd: string, pid: number): string | undefined {
  const dir = path.join(cwd, ".substrate", "state");
  if (!fs.existsSync(dir)) return undefined;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".lock")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { pid?: unknown; run_id?: unknown };
      if (data.pid === pid && typeof data.run_id === "string") return data.run_id;
    } catch {
      // A lock being written: the next poll sees it.
    }
  }
  return undefined;
}

export interface DetachContext {
  cwd: string;
  /** The CLI's argv after the script, with --detach removed. */
  args: string[];
  /** Stdin the parent already read (a prompt or request piped in); the child reads it from a pipe. */
  stdin?: string;
  outputFormat?: "text" | "json" | "stream-json";
  stdout: TextSink;
  stderr: TextSink;
}

function tailOf(file: string): string {
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split("\n");
  return lines.slice(-TAIL_LINES - 1).join("\n");
}

/**
 * Starts this CLI again as a detached child (own session, stdin ignored or piped, output to
 * `.substrate/detached/<unix-ms>-<pid>.log`, SIGHUP ignored) and waits for its run to hold the lock.
 * Exit 0 with the run's id and commands once the run exists. When the child exits first, its log's
 * tail is printed and the child's exit code is returned; a child still without a run after
 * DETACH_WAIT_MS is ended and the call exits 1. `process.argv[1]` is the script the child runs, so a
 * caller must be the built CLI (dist/substrate.mjs) or a test that runs it.
 */
export async function startDetached(ctx: DetachContext): Promise<number> {
  const script = process.argv[1];
  const logDir = path.join(ctx.cwd, ".substrate", "detached");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${Date.now()}-${process.pid}.log`);
  const fd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [script, ...ctx.args], {
    cwd: ctx.cwd,
    detached: true,
    stdio: [ctx.stdin !== undefined ? "pipe" : "ignore", fd, fd],
    env: { ...process.env, SUBSTRATE_DETACHED: "1" },
  });
  fs.closeSync(fd);
  if (ctx.stdin !== undefined) child.stdin?.end(ctx.stdin);

  let exited = false;
  let exitCode = 1;
  let spawnError: Error | undefined;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code ?? 1;
  });
  child.on("error", (err) => {
    spawnError = err;
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    ctx.stderr.write(`Error: could not start the background run: ${spawnError?.message ?? "no process"}\n`);
    return 1;
  }

  const deadline = Date.now() + DETACH_WAIT_MS;
  let runId: string | undefined;
  while (!exited && Date.now() < deadline) {
    runId = runIdOfLockPid(ctx.cwd, pid);
    if (runId !== undefined) break;
    await sleep(POLL_MS);
  }
  if (runId === undefined && !exited) {
    runId = runIdOfLockPid(ctx.cwd, pid);
  }

  if (runId === undefined) {
    const tail = tailOf(logFile);
    if (tail.trim().length > 0) ctx.stderr.write(tail.endsWith("\n") ? tail : `${tail}\n`);
    if (!exited) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // gone
      }
      ctx.stderr.write(`no run started within ${DETACH_WAIT_MS / 1000} s; log: ${path.relative(ctx.cwd, logFile)}\n`);
      return 1;
    }
    return exitCode;
  }

  const log = `.substrate/runs/${runId}/progress.log`;
  const watch = `substrate watch ${runId}`;
  const status = `substrate status ${runId}`;
  const stop = `substrate stop ${runId}`;
  if (ctx.outputFormat === "json") {
    ctx.stdout.write(JSON.stringify({ run_id: runId, pid, log, watch, status, stop }) + "\n");
  } else {
    ctx.stdout.write(
      `run ${runId} started in the background (pid ${pid})\n` +
        `watch:  ${watch}\n` +
        `status: ${status}\n` +
        `stop:   ${stop}\n` +
        `log:    ${log}\n`,
    );
  }
  return 0;
}

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
