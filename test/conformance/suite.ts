import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Capabilities,
  EnvReport,
  SpawnRequest,
  BackendEvent,
  SessionResult,
  type HarnessAdapter,
} from "../../src/contracts/index.js";
import type { FakeScenarioName } from "../fixtures/fake-harness/index.js";

export type AdapterFactory = () => HarnessAdapter | Promise<HarnessAdapter>;

export interface ConformanceOptions {
  live?: boolean;
  timeoutMs?: number;
  maxCostUsd?: number;
  skipScenarios?: FakeScenarioName[];
}

export function runAdapterConformanceSuite(
  name: string,
  factory: AdapterFactory,
  options?: ConformanceOptions
): void {
  describe(`Adapter Conformance: ${name}`, () => {
    let adapter: HarnessAdapter;

    beforeAll(async () => {
      adapter = await factory();
    });

    it("satisfies Capabilities schema and exposes valid capability flags", () => {
      expect(Capabilities.safeParse(adapter.capabilities).success).toBe(true);
      expect(typeof adapter.capabilities.name).toBe("string");
      expect(typeof adapter.capabilities.version_pin).toBe("string");
      expect(typeof adapter.capabilities.effort).toBe("boolean");
      expect(typeof adapter.capabilities.resume).toBe("boolean");
    });

    it("validateEnvironment returns valid EnvReport", async () => {
      const report = await adapter.validateEnvironment();
      expect(EnvReport.safeParse(report).success).toBe(true);
      expect(typeof report.ok).toBe("boolean");
      expect(typeof report.pin_matches).toBe("boolean");
      expect(Array.isArray(report.problems)).toBe(true);
    });

    it("spawns session and adheres to lifecycle, yielding valid events and result", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "conformance-basic-"));
      try {
        const req: SpawnRequest = {
          role: "worker",
          cwd,
          prompt: "echo hello",
          model: "claude-haiku-5-5",
          permission: { allow: ["Bash"], deny: [] },
          budget: { timeout_ms: 30000 },
        };

        const handle = adapter.spawn(req);
        expect(handle.pid).toBeGreaterThan(0);

        const events: BackendEvent[] = [];
        for await (const event of handle.events) {
          expect(BackendEvent.safeParse(event).success).toBe(true);
          events.push(event);
        }

        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(events[0].type).toBe("session.started");
        expect(events[events.length - 1].type).toBe("session.result");

        const result = await handle.result();
        expect(SessionResult.safeParse(result).success).toBe(true);
        expect(result.ok).toBe(true);
        expect(result.exit_code).toBe(0);
        expect(result.session_id).toBeTruthy();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("terminates process group on handle.kill('cancel') and marks killed_for: cancel", async () => {
      if (options?.skipScenarios?.includes("hang")) return;

      const cwd = mkdtempSync(join(tmpdir(), "conformance-kill-"));
      try {
        const req: SpawnRequest = {
          role: "worker",
          cwd,
          prompt: "scenario:hang",
          model: "claude-haiku-5-5",
          permission: { allow: [], deny: [] },
          budget: { timeout_ms: 30000 },
        };

        const handle = adapter.spawn(req);
        expect(handle.pid).toBeGreaterThan(0);

        // Give process a moment to initialize
        await new Promise((r) => setTimeout(r, 100));

        await handle.kill("cancel");

        const events: BackendEvent[] = [];
        for await (const event of handle.events) {
          expect(BackendEvent.safeParse(event).success).toBe(true);
          events.push(event);
        }

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[events.length - 1].type).toBe("session.result");

        const result = await handle.result();
        expect(SessionResult.safeParse(result).success).toBe(true);
        expect(result.ok).toBe(false);
        expect(result.killed_for).toBe("cancel");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("terminates process group on handle.kill('budget') and marks killed_for: budget", async () => {
      if (options?.skipScenarios?.includes("hang")) return;

      const cwd = mkdtempSync(join(tmpdir(), "conformance-budget-"));
      try {
        const req: SpawnRequest = {
          role: "worker",
          cwd,
          prompt: "scenario:hang",
          model: "claude-haiku-5-5",
          permission: { allow: [], deny: [] },
          budget: { timeout_ms: 30000 },
        };

        const handle = adapter.spawn(req);
        expect(handle.pid).toBeGreaterThan(0);

        await new Promise((r) => setTimeout(r, 100));
        await handle.kill("budget");

        const result = await handle.result();
        expect(SessionResult.safeParse(result).success).toBe(true);
        expect(result.ok).toBe(false);
        expect(result.killed_for).toBe("budget");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("records tool denial event and updates result.denials", async () => {
      if (options?.skipScenarios?.includes("soft_deny")) return;

      const cwd = mkdtempSync(join(tmpdir(), "conformance-denial-"));
      try {
        const req: SpawnRequest = {
          role: "worker",
          cwd,
          prompt: "scenario:soft_deny",
          model: "claude-haiku-5-5",
          permission: { allow: [], deny: ["Bash"] },
          budget: { timeout_ms: 30000 },
        };

        const handle = adapter.spawn(req);
        const events: BackendEvent[] = [];
        for await (const event of handle.events) {
          expect(BackendEvent.safeParse(event).success).toBe(true);
          events.push(event);
        }

        const denialEvent = events.find((e) => e.type === "permission.denied");
        expect(denialEvent).toBeDefined();

        const result = await handle.result();
        expect(SessionResult.safeParse(result).success).toBe(true);
        expect(result.denials.length).toBeGreaterThan(0);
        expect(result.denials.some((d) => d.tool === "Bash")).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("supports session resume with matching session_id", async () => {
      if (options?.skipScenarios?.includes("resume")) return;

      const cwd = mkdtempSync(join(tmpdir(), "conformance-resume-"));
      try {
        const targetSessionId = "sess-resume-conformance-123";
        const req: SpawnRequest = {
          role: "worker",
          cwd,
          prompt: "scenario:resume",
          model: "claude-haiku-5-5",
          permission: { allow: [], deny: [] },
          budget: { timeout_ms: 30000 },
          session: { resume: targetSessionId },
        };

        const handle = adapter.spawn(req);
        const events: BackendEvent[] = [];
        for await (const event of handle.events) {
          expect(BackendEvent.safeParse(event).success).toBe(true);
          events.push(event);
        }

        expect(events[0].type).toBe("session.started");
        if (events[0].type === "session.started") {
          expect(events[0].session_id).toBe(targetSessionId);
        }

        const result = await handle.result();
        expect(SessionResult.safeParse(result).success).toBe(true);
        expect(result.session_id).toBe(targetSessionId);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
}
