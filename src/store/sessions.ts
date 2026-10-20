import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RunId } from "../contracts/index.js";

export interface SessionPromptEntry {
  prompt: string;
  timestamp: string;
}

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  mode: "auto" | "solo" | "plan";
  prompts: SessionPromptEntry[];
  runs: RunId[];
}

export interface SessionStore {
  create(opts: {
    mode: "auto" | "solo" | "plan";
    prompt?: string;
  }): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | null>;
  list(): Promise<SessionRecord[]>;
  getLatest(): Promise<SessionRecord | null>;
  addRun(sid: string, rid: RunId, p?: string): Promise<SessionRecord>;
  fork(sessionId: string): Promise<SessionRecord>;
}

class SessionStoreImpl implements SessionStore {
  private readonly sessionsDir: string;

  constructor(substrateDir?: string) {
    const base = substrateDir ?? path.join(process.cwd(), ".substrate");
    this.sessionsDir = path.join(base, "sessions");
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  private getFilePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  async create(opts: {
    mode: "auto" | "solo" | "plan";
    prompt?: string;
  }): Promise<SessionRecord> {
    this.ensureDir();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: `sess_${crypto.randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      mode: opts.mode,
      prompts: opts.prompt ? [{ prompt: opts.prompt, timestamp: now }] : [],
      runs: [],
    };

    fs.writeFileSync(
      this.getFilePath(record.sessionId),
      JSON.stringify(record, null, 2),
      "utf8",
    );

    return record;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const filePath = this.getFilePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content);
      if (
        !parsed ||
        typeof parsed.sessionId !== "string" ||
        typeof parsed.createdAt !== "string" ||
        typeof parsed.updatedAt !== "string" ||
        !Array.isArray(parsed.prompts) ||
        !Array.isArray(parsed.runs)
      ) {
        return null;
      }
      return parsed as SessionRecord;
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionRecord[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.sessionsDir);
    const records: SessionRecord[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const rec = await this.get(id);
      if (rec) {
        records.push(rec);
      }
    }

    records.sort(
      (a, b) =>
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
    );
    return records;
  }

  async getLatest(): Promise<SessionRecord | null> {
    const records = await this.list();
    if (records.length === 0) {
      return null;
    }
    return records[records.length - 1];
  }

  async addRun(
    sid: string,
    rid: RunId,
    p?: string,
  ): Promise<SessionRecord> {
    const record = await this.get(sid);
    if (!record) {
      throw new Error(`Session not found: ${sid}`);
    }

    const now = new Date().toISOString();
    record.runs.push(rid);
    if (p) {
      record.prompts.push({ prompt: p, timestamp: now });
    }
    record.updatedAt = now;

    this.ensureDir();
    fs.writeFileSync(
      this.getFilePath(sid),
      JSON.stringify(record, null, 2),
      "utf8",
    );

    return record;
  }

  async fork(sessionId: string): Promise<SessionRecord> {
    const source = await this.get(sessionId);
    if (!source) {
      throw new Error(`No session to fork: ${sessionId}`);
    }

    this.ensureDir();
    const now = new Date().toISOString();
    const forked: SessionRecord = {
      sessionId: `sess_${crypto.randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      mode: source.mode,
      prompts: source.prompts.map((p) => ({ ...p })),
      runs: [],
    };

    fs.writeFileSync(
      this.getFilePath(forked.sessionId),
      JSON.stringify(forked, null, 2),
      "utf8",
    );

    return forked;
  }
}

export function createSessionStore(substrateDir?: string): SessionStore {
  return new SessionStoreImpl(substrateDir);
}
