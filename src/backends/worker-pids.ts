import fs from "node:fs";
import path from "node:path";

import { killProcessGroup } from "./process.js";

// R8.2: a worker's process group is recorded in the run directory while its session runs, so
// a run whose CLI was killed without a chance to clean up (SIGKILL, a crash) does not leave a
// harness process behind. `endStaleWorkers` runs when a run is resumed, under the run lock.

export interface WorkerPidRecord {
  task_id: string;
  generation: number;
  attempt: number;
  pid: number;
  backend: string;
}

function workersDir(runDir: string): string {
  return path.join(runDir, "workers");
}

function recordFile(runDir: string, rec: Pick<WorkerPidRecord, "task_id" | "generation" | "attempt">): string {
  return path.join(workersDir(runDir), `${rec.task_id}-g${rec.generation}-a${rec.attempt}.json`);
}

/** Writes the record of a session that has just been spawned. */
export function recordWorkerPid(runDir: string, rec: WorkerPidRecord): void {
  fs.mkdirSync(workersDir(runDir), { recursive: true });
  fs.writeFileSync(recordFile(runDir, rec), JSON.stringify(rec), "utf8");
}

/** Removes the record once the session has ended, however it ended. */
export function clearWorkerPid(runDir: string, rec: Pick<WorkerPidRecord, "task_id" | "generation" | "attempt">): void {
  fs.rmSync(recordFile(runDir, rec), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== "ESRCH";
  }
}

/**
 * True when the process's command line names the backend. Linux only (/proc); elsewhere the
 * command line cannot be read, so the process is not touched.
 */
function commandNames(pid: number, backend: string): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    return cmdline.includes(backend);
  } catch {
    return false;
  }
}

/**
 * Ends the worker process groups a previous CLI left behind: each recorded group that is still
 * alive and whose command line names its backend is killed (SIGKILL). Every record is removed.
 * Returns the pids it ended.
 */
export function endStaleWorkers(runDir: string): number[] {
  const dir = workersDir(runDir);
  if (!fs.existsSync(dir)) return [];
  const ended: number[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    let rec: WorkerPidRecord | undefined;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8")) as WorkerPidRecord;
    } catch {
      rec = undefined;
    }
    if (rec && Number.isInteger(rec.pid) && rec.pid > 0 && isAlive(rec.pid) && commandNames(rec.pid, rec.backend)) {
      killProcessGroup(rec.pid, "SIGKILL");
      ended.push(rec.pid);
    }
    fs.rmSync(file, { force: true });
  }
  return ended;
}
