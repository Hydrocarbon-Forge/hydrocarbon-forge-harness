import fs from "node:fs";
import path from "node:path";
import type { RunId } from "../contracts/index.js";

export interface RunLock {
  acquire(): Promise<boolean>;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
  isStale(): Promise<boolean>;
}

function isPidAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

export class RunLockImpl implements RunLock {
  private readonly lockPath: string;
  private readonly staleTimeoutMs: number;

  constructor(
    private readonly runId: RunId,
    options?: { baseDir?: string; staleTimeoutMs?: number }
  ) {
    const baseDir = options?.baseDir ?? process.cwd();
    this.staleTimeoutMs = options?.staleTimeoutMs ?? 30000;
    this.lockPath = path.join(baseDir, ".substrate", "state", `${runId}.lock`);
  }

  async isStale(): Promise<boolean> {
    if (!fs.existsSync(this.lockPath)) {
      return false;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
      const now = Date.now();
      const heartbeatTime = new Date(data.heartbeat_at).getTime();
      if (isNaN(heartbeatTime) || now - heartbeatTime > this.staleTimeoutMs) {
        return true;
      }
      if (!isPidAlive(data.pid)) {
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  async acquire(): Promise<boolean> {
    if (fs.existsSync(this.lockPath)) {
      let isStaleLock = false;
      try {
        const data = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
        const now = Date.now();
        const heartbeatTime = new Date(data.heartbeat_at).getTime();
        const expired = isNaN(heartbeatTime) || now - heartbeatTime > this.staleTimeoutMs;
        const alive = isPidAlive(data.pid);
        if (expired || !alive) {
          isStaleLock = true;
        }
      } catch {
        isStaleLock = true;
      }

      if (!isStaleLock) {
        return false;
      }
    }

    const lockDir = path.dirname(this.lockPath);
    fs.mkdirSync(lockDir, { recursive: true });

    const now = new Date().toISOString();
    const lockData = {
      pid: process.pid,
      run_id: this.runId,
      acquired_at: now,
      heartbeat_at: now,
    };
    fs.writeFileSync(this.lockPath, JSON.stringify(lockData), "utf8");
    return true;
  }

  async heartbeat(): Promise<void> {
    if (!fs.existsSync(this.lockPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
      data.heartbeat_at = new Date().toISOString();
      fs.writeFileSync(this.lockPath, JSON.stringify(data), "utf8");
    } catch {
      // Ignore
    }
  }

  async release(): Promise<void> {
    if (!fs.existsSync(this.lockPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
      if (data.pid === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Ignore
    }
  }
}
