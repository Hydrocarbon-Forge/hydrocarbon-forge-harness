import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// R10.3: `run --detach` and `resume --detach`. The CLI starts itself as a detached child in its own
// session, with its output in a log file, waits until the child's run holds its lock, prints how to
// watch, check and stop it, and exits. The child runs exactly as a foreground run does.

/** How long a detached start waits for the child's run to take its lock. */
export const DETACH_WAIT_MS = 30000;
const POLL_MS = 100;
const TAIL_LINES = 40;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
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
 * DETACH_WAIT_MS is ended and the call exits 1.
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

/**
 * The `--detach` route of run and resume (R10.3): the CLI's own arguments minus --detach start the
 * child. stream-json cannot be followed from a detached start, so it is refused before anything runs.
 */
export async function detachFrom(ctx: {
  cwd: string;
  argv?: string[];
  flags: { outputFormat?: "text" | "json" | "stream-json" };
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  if (ctx.flags.outputFormat === "stream-json") {
    ctx.stderr.write("Error: --detach cannot stream; use substrate watch\n");
    return 2;
  }
  return startDetached({
    cwd: ctx.cwd,
    args: (ctx.argv ?? []).filter((arg) => arg !== "--detach"),
    ...(ctx.stdin !== undefined ? { stdin: ctx.stdin } : {}),
    outputFormat: ctx.flags.outputFormat,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });
}
