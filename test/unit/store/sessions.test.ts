import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";

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
  runs: Contracts.RunId[];
}

export interface SessionStore {
  create(opts: {
    mode: "auto" | "solo" | "plan";
    prompt?: string;
  }): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | null>;
  list(): Promise<SessionRecord[]>;
  getLatest(): Promise<SessionRecord | null>;
  addRun(sid: string, rid: Contracts.RunId, p?: string): Promise<SessionRecord>;
  fork(sessionId: string): Promise<SessionRecord>;
}

export type CreateSessionStoreFn = (substrateDir?: string) => SessionStore;
export type ResolveResumeTargetFn = (
  target: string,
  sessions: SessionStore,
  runsDir: string,
) => Promise<{ runId: Contracts.RunId; sessionId?: string }>;

async function loadSessionsModule(): Promise<{
  createSessionStore: CreateSessionStoreFn;
  resolveResumeTarget: ResolveResumeTargetFn;
}> {
  return (await import("../../../src/store/sessions.js" as any)) as any;
}

describe("store: SessionStore persistence and resolution", () => {
  let tmpDir: string;
  let substrateDir: string;
  let sessionsDir: string;
  let runsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-sessions-test-"));
    substrateDir = join(tmpDir, ".substrate");
    sessionsDir = join(substrateDir, "sessions");
    runsDir = join(substrateDir, "runs");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("creates a new session record without initial prompt and saves to .substrate/sessions/<id>.json", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const before = new Date().toISOString();
      const session = await store.create({ mode: "auto" });
      const after = new Date().toISOString();

      expect(session).toBeDefined();
      expect(typeof session.sessionId).toBe("string");
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.mode).toBe("auto");
      expect(session.prompts).toEqual([]);
      expect(session.runs).toEqual([]);
      expect(session.createdAt >= before && session.createdAt <= after).toBe(true);
      expect(session.updatedAt >= before && session.updatedAt <= after).toBe(true);

      const filePath = join(sessionsDir, `${session.sessionId}.json`);
      expect(existsSync(filePath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as SessionRecord;
      expect(onDisk.sessionId).toBe(session.sessionId);
      expect(onDisk.mode).toBe("auto");
      expect(onDisk.runs).toEqual([]);
      expect(onDisk.prompts).toEqual([]);
    });

    it("creates a new session record with initial prompt entry and timestamp", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const session = await store.create({
        mode: "solo",
        prompt: "Fix crash on boot",
      });

      expect(session.mode).toBe("solo");
      expect(session.prompts).toHaveLength(1);
      expect(session.prompts[0].prompt).toBe("Fix crash on boot");
      expect(typeof session.prompts[0].timestamp).toBe("string");
      expect(session.runs).toEqual([]);

      const filePath = join(sessionsDir, `${session.sessionId}.json`);
      const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as SessionRecord;
      expect(onDisk.prompts[0].prompt).toBe("Fix crash on boot");
    });

    it("supports all valid session modes: auto, solo, plan", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const autoSess = await store.create({ mode: "auto" });
      const soloSess = await store.create({ mode: "solo" });
      const planSess = await store.create({ mode: "plan" });

      expect(autoSess.mode).toBe("auto");
      expect(soloSess.mode).toBe("solo");
      expect(planSess.mode).toBe("plan");
    });
  });

  describe("get()", () => {
    it("returns null for non-existent session ID", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const result = await store.get("non-existent-session-id");
      expect(result).toBeNull();
    });

    it("returns the session record for existing session ID", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const created = await store.create({ mode: "plan", prompt: "Design migration" });
      const fetched = await store.get(created.sessionId);

      expect(fetched).not.toBeNull();
      expect(fetched?.sessionId).toBe(created.sessionId);
      expect(fetched?.mode).toBe("plan");
      expect(fetched?.prompts[0].prompt).toBe("Design migration");
    });
  });

  describe("list() and getLatest()", () => {
    it("returns empty array when no sessions exist", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const list = await store.list();
      expect(list).toEqual([]);
      const latest = await store.getLatest();
      expect(latest).toBeNull();
    });

    it("lists all sessions and identifies getLatest() based on most recent update", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const s1 = await store.create({ mode: "auto", prompt: "First prompt" });
      // Small pause to guarantee timestamp distinction
      await new Promise((r) => setTimeout(r, 10));
      const s2 = await store.create({ mode: "solo", prompt: "Second prompt" });

      const list = await store.list();
      expect(list).toHaveLength(2);
      const sessionIds = list.map((s) => s.sessionId);
      expect(sessionIds).toContain(s1.sessionId);
      expect(sessionIds).toContain(s2.sessionId);

      const latest = await store.getLatest();
      expect(latest).not.toBeNull();
      expect(latest?.sessionId).toBe(s2.sessionId);
    });

    it("tolerates corrupt or invalid JSON session files without crashing", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const validSession = await store.create({ mode: "auto", prompt: "Valid session" });

      // Write a malformed file in the sessions directory
      writeFileSync(join(sessionsDir, "corrupted-session.json"), "{ invalid JSON content", "utf8");
      // Write another file that is valid JSON but missing required fields
      writeFileSync(join(sessionsDir, "empty-obj.json"), "{}", "utf8");

      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0].sessionId).toBe(validSession.sessionId);

      const latest = await store.getLatest();
      expect(latest).not.toBeNull();
      expect(latest?.sessionId).toBe(validSession.sessionId);
    });
  });

  describe("addRun()", () => {
    it("appends run ID to existing session and updates updatedAt", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const session = await store.create({ mode: "auto" });
      const initialUpdated = session.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      const runId = createRunId() as Contracts.RunId;
      const updated = await store.addRun(session.sessionId, runId);

      expect(updated.runs).toEqual([runId]);
      expect(updated.updatedAt >= initialUpdated).toBe(true);

      // Verify persisted to disk
      const fetched = await store.get(session.sessionId);
      expect(fetched?.runs).toEqual([runId]);
    });

    it("appends run ID and prompt entry when prompt is provided", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const session = await store.create({ mode: "auto", prompt: "Prompt 1" });
      const runId1 = createRunId() as Contracts.RunId;
      await store.addRun(session.sessionId, runId1);

      const runId2 = createRunId() as Contracts.RunId;
      const updated = await store.addRun(session.sessionId, runId2, "Followup prompt 2");

      expect(updated.runs).toEqual([runId1, runId2]);
      expect(updated.prompts).toHaveLength(2);
      expect(updated.prompts[1].prompt).toBe("Followup prompt 2");
    });

    it("rejects when adding run to a non-existent session ID", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const runId = createRunId() as Contracts.RunId;
      await expect(store.addRun("does-not-exist", runId)).rejects.toThrow();
    });
  });

  describe("fork()", () => {
    it("creates a new session copying prompt history and mode, with fresh ID and empty runs", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const original = await store.create({ mode: "solo", prompt: "Initial goal" });
      const runId = createRunId() as Contracts.RunId;
      await store.addRun(original.sessionId, runId, "Followup instruction");

      const forked = await store.fork(original.sessionId);

      expect(forked.sessionId).not.toBe(original.sessionId);
      expect(forked.mode).toBe("solo");
      expect(forked.prompts).toHaveLength(2);
      expect(forked.prompts[0].prompt).toBe("Initial goal");
      expect(forked.prompts[1].prompt).toBe("Followup instruction");
      expect(forked.runs).toEqual([]);

      // Verify source session is unchanged
      const originalCheck = await store.get(original.sessionId);
      expect(originalCheck?.runs).toEqual([runId]);

      // Verify forked session is persisted
      const forkedCheck = await store.get(forked.sessionId);
      expect(forkedCheck?.sessionId).toBe(forked.sessionId);
      expect(forkedCheck?.runs).toEqual([]);
    });

    it("rejects when attempting to fork a non-existent session", async () => {
      const { createSessionStore } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      await expect(store.fork("missing-session-id")).rejects.toThrow();
    });
  });

  describe("resolveResumeTarget()", () => {
    it("resolves session ID to its latest run ID (session thread disambiguation)", async () => {
      const { createSessionStore, resolveResumeTarget } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const session = await store.create({ mode: "auto", prompt: "Build task" });
      const runId1 = createRunId() as Contracts.RunId;
      const runId2 = createRunId() as Contracts.RunId;
      await store.addRun(session.sessionId, runId1);
      await store.addRun(session.sessionId, runId2);

      const target = await resolveResumeTarget(session.sessionId, store, runsDir);
      expect(target.runId).toBe(runId2);
      expect(target.sessionId).toBe(session.sessionId);
    });

    it("resolves direct run ID when target matches a run directory", async () => {
      const { createSessionStore, resolveResumeTarget } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const runId = createRunId() as Contracts.RunId;
      const runDir = join(runsDir, runId);
      mkdirSync(runDir, { recursive: true });

      const target = await resolveResumeTarget(runId, store, runsDir);
      expect(target.runId).toBe(runId);
    });

    it("prefers session resolution when an identifier matches session record", async () => {
      const { createSessionStore, resolveResumeTarget } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const session = await store.create({ mode: "auto" });
      const runId = createRunId() as Contracts.RunId;
      await store.addRun(session.sessionId, runId);

      // Create a conflicting directory named with the session ID
      mkdirSync(join(runsDir, session.sessionId), { recursive: true });

      const target = await resolveResumeTarget(session.sessionId, store, runsDir);
      // Disambiguation checks session store first
      expect(target.sessionId).toBe(session.sessionId);
      expect(target.runId).toBe(runId);
    });

    it("resolves to latest run of latest session when target is empty or omitted", async () => {
      const { createSessionStore, resolveResumeTarget } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const s1 = await store.create({ mode: "auto" });
      const r1 = createRunId() as Contracts.RunId;
      await store.addRun(s1.sessionId, r1);

      await new Promise((r) => setTimeout(r, 10));
      const s2 = await store.create({ mode: "auto" });
      const r2 = createRunId() as Contracts.RunId;
      await store.addRun(s2.sessionId, r2);

      const target = await resolveResumeTarget("", store, runsDir);
      expect(target.runId).toBe(r2);
      expect(target.sessionId).toBe(s2.sessionId);
    });

    it("throws when session exists but contains no runs", async () => {
      const { createSessionStore, resolveResumeTarget } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      const session = await store.create({ mode: "auto" });

      await expect(resolveResumeTarget(session.sessionId, store, runsDir)).rejects.toThrow();
    });

    it("throws when target matches neither session nor run directory", async () => {
      const { createSessionStore, resolveResumeTarget } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      await expect(
        resolveResumeTarget("unknown-target-xyz", store, runsDir),
      ).rejects.toThrow(/Neither session nor run found/i);
    });

    it("throws when target is empty and no sessions or runs exist", async () => {
      const { createSessionStore, resolveResumeTarget } = await loadSessionsModule();
      const store = createSessionStore(substrateDir);

      await expect(
        resolveResumeTarget("", store, runsDir),
      ).rejects.toThrow();
    });
  });
});
