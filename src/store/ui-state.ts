import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { xdgStateHome } from "../ledger/usage.js";
import { isSubstrateProcess, processInfoOf } from "../util/process-control.js";

// The files of the always-on browser UI (web-ui design, sections 8.2 and 8.3): the user-level `ui.json` (the port,
// next to settings.json), and the state files `ui.pid` and `ui.log` under `$XDG_STATE_HOME/substrate`. Neutral: the
// CLI (`ui start | stop | status`) and the server (`ui serve`) both use it, and it imports neither.

const UI_CONFIG_NAME = "ui.json";
const UI_PID_NAME = "ui.pid";
const UI_LOG_NAME = "ui.log";

/** The user-level config file: `ui.json` in the directory of settings.json ($SUBSTRATE_CONFIG_DIR, else ~/.config/substrate). */
export function uiConfigFileOf(env: NodeJS.ProcessEnv): string {
  const dir = env.SUBSTRATE_CONFIG_DIR && env.SUBSTRATE_CONFIG_DIR.length > 0
    ? env.SUBSTRATE_CONFIG_DIR
    : path.join(os.homedir(), ".config", "substrate");
  return path.join(dir, UI_CONFIG_NAME);
}

/** The pid file `serve` writes while it runs: `$XDG_STATE_HOME/substrate/ui.pid`. */
export function uiPidFileOf(env: NodeJS.ProcessEnv): string {
  return path.join(xdgStateHome(env), "substrate", UI_PID_NAME);
}

/** The log a detached `ui start` appends to: `$XDG_STATE_HOME/substrate/ui.log`. */
export function uiLogFileOf(env: NodeJS.ProcessEnv): string {
  return path.join(xdgStateHome(env), "substrate", UI_LOG_NAME);
}

/** The port the config file names, or undefined when the file does not exist. A file that names no valid port throws. */
export function readUiPort(file: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file} is not readable`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const port = (parsed as { port?: unknown } | null)?.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${file} does not name a port from 0 to 65535`);
  }
  return port;
}

/** Stores the port in ui.json (atomically), so the URL stays the same across restarts and the systemd unit. */
export function writeUiPort(file: string, port: number, now: Date = new Date()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { version: 1, port, chosen_at: now.toISOString() };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * The port a `serve` binds. A `--port` flag wins, then the stored port; with neither the port is new: the
 * operating system chooses one (port 0) and the caller stores it.
 */
export function choosePort(
  flag: number | undefined,
  stored: number | undefined,
): { port: number; source: "flag" | "config" | "new" } {
  if (flag !== undefined) return { port: flag, source: "flag" };
  if (stored !== undefined) return { port: stored, source: "config" };
  return { port: 0, source: "new" };
}

/** What `serve` records in ui.pid once it is listening. */
export interface UiPidRecord {
  pid: number;
  url: string;
  started_at: string;
  node: string;
}

export function writeUiPidRecord(file: string, record: UiPidRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
}

export function removeUiPidRecord(file: string): void {
  fs.rmSync(file, { force: true });
}

function readUiPidRecord(file: string): UiPidRecord | undefined {
  let parsed: Partial<UiPidRecord>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<UiPidRecord>;
  } catch {
    return undefined;
  }
  if (typeof parsed.pid !== "number" || typeof parsed.url !== "string") return undefined;
  return {
    pid: parsed.pid,
    url: parsed.url,
    started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
    node: typeof parsed.node === "string" ? parsed.node : "",
  };
}

/** A `substrate ui serve` process: its command line names substrate and the words `ui serve`. */
export function isUiServeProcess(args: string): boolean {
  return isSubstrateProcess(args) && /\bui\s+serve\b/.test(args);
}

/**
 * The state of the pid file: none (no file), stale (the file names a pid that is gone, or is not a `ui serve`
 * process: a recycled pid is never signalled), or live. `info` is the process table lookup (injected in tests).
 */
export function uiPidStateOf(
  file: string,
  info: (pid: number) => { alive: boolean; args: string } = processInfoOf,
): { state: "none" } | { state: "stale"; record: UiPidRecord } | { state: "live"; record: UiPidRecord } {
  const record = readUiPidRecord(file);
  if (record === undefined) return { state: "none" };
  const proc = info(record.pid);
  if (proc.alive && isUiServeProcess(proc.args)) return { state: "live", record };
  return { state: "stale", record };
}

/** Whether the server at `url` answers its health endpoint (GET /api/health) with 200 within `timeoutMs`. */
export function probeHealth(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(new URL("/api/health", url), (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}
