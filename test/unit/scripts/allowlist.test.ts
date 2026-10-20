import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
// @ts-ignore
import * as allowlistMod from "../../../scripts/lib/allowlist.mjs";
const {
  loadAllowlist,
  workPackageStatus,
  matchesEntry,
  applyAllowlist,
} = allowlistMod as any;

describe("allowlist module", () => {
  it("loads allowlist with default empty structure when file does not exist", () => {
    const list = loadAllowlist("/nonexistent/file.json");
    expect(list).toEqual({
      purity: [],
      wired: [],
      events: [],
      events_observe_only: [],
      settings: [],
    });
  });

  it("parses work package status from PROGRESS.md correctly", () => {
    const fixtureProgress = path.resolve("test/fixtures/check/clean/docs/plan/PROGRESS.md");
    const status = workPackageStatus(fixtureProgress);
    expect(status.get("R0.1")).toBe("TODO");
  });

  it("treats missing PROGRESS.md as TODO for all work packages", () => {
    const status = workPackageStatus("/nonexistent/PROGRESS.md");
    expect(status.get("R0.1")).toBe("TODO");
    expect(status.get("R9.9")).toBe("TODO");
  });

  describe("matchesEntry", () => {
    it("matches purity entries exactly by rule and path", () => {
      const entry = { rule: "P2", path: "src/engine/engine.ts", until: "R0.5" };
      expect(matchesEntry("purity", entry, { rule: "P2", path: "src/engine/engine.ts" })).toBe(true);
      expect(matchesEntry("purity", entry, { rule: "P1", path: "src/engine/engine.ts" })).toBe(false);
      expect(matchesEntry("purity", entry, { rule: "P2", path: "src/engine/other.ts" })).toBe(false);
    });

    it("matches wired entries with exact path or /** prefix", () => {
      const exact = { path: "src/cli/bench.ts", until: "R1.8" };
      expect(matchesEntry("wired", exact, { path: "src/cli/bench.ts" })).toBe(true);
      expect(matchesEntry("wired", exact, { path: "src/cli/other.ts" })).toBe(false);

      const wildcard = { path: "src/tui/**", until: "R0.7" };
      expect(matchesEntry("wired", wildcard, { path: "src/tui/app.ts" })).toBe(true);
      expect(matchesEntry("wired", wildcard, { path: "src/tui/sub/file.ts" })).toBe(true);
      expect(matchesEntry("wired", wildcard, { path: "src/engine/app.ts" })).toBe(false);
    });

    it("matches events entries by type and kind", () => {
      const entry = { type: "task.started", kind: "consumed-not-emitted", until: "R1.2" };
      expect(matchesEntry("events", entry, { type: "task.started", kind: "consumed-not-emitted" })).toBe(true);
      expect(matchesEntry("events", entry, { type: "task.started", kind: "emitted-not-consumed" })).toBe(false);
      expect(matchesEntry("events", entry, { type: "task.other", kind: "consumed-not-emitted" })).toBe(false);
    });

    it("matches settings entries by exact key or .* prefix", () => {
      const exact = { key: "git.auto_merge", until: "R1.6" };
      expect(matchesEntry("settings", exact, { key: "git.auto_merge" })).toBe(true);
      expect(matchesEntry("settings", exact, { key: "git.branch_prefix" })).toBe(false);

      const wildcard = { key: "roles.reviewer.*", until: "DEFERRED" };
      expect(matchesEntry("settings", wildcard, { key: "roles.reviewer.enabled" })).toBe(true);
      expect(matchesEntry("settings", wildcard, { key: "roles.reviewer.model" })).toBe(true);
      expect(matchesEntry("settings", wildcard, { key: "roles.planner.model" })).toBe(false);
    });
  });

  describe("applyAllowlist rules", () => {
    const statusMap = new Map([
      ["R0.1", "DONE"],
      ["R0.2", "TODO"],
    ]);

    it("suppresses matched violations", () => {
      const allowlist = {
        purity: [{ rule: "P2", path: "src/engine/effects.ts", until: "R0.2" }],
      };
      const violations = [
        { rule: "P2", path: "src/engine/effects.ts", line: 10, message: "forbidden" },
      ];
      const { remaining, problems } = applyAllowlist("purity", violations, allowlist, statusMap);
      expect(remaining).toHaveLength(0);
      expect(problems).toHaveLength(0);
    });

    it("fails on stale allowlist entries that match nothing", () => {
      const allowlist = {
        purity: [{ rule: "P2", path: "src/engine/clean.ts", until: "R0.2" }],
      };
      const violations: any[] = [];
      const { problems } = applyAllowlist("purity", violations, allowlist, statusMap);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("Stale allowlist entry");
    });

    it("fails when an entry's until WP has status DONE", () => {
      const allowlist = {
        purity: [{ rule: "P2", path: "src/engine/effects.ts", until: "R0.1" }],
      };
      const violations = [
        { rule: "P2", path: "src/engine/effects.ts", line: 10, message: "forbidden" },
      ];
      const { problems } = applyAllowlist("purity", violations, allowlist, statusMap);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("Debt of finished WP R0.1 still present");
    });

    it("exempts DEFERRED entries from the finished WP check", () => {
      const allowlist = {
        settings: [{ key: "roles.reviewer.*", until: "DEFERRED" }],
      };
      const violations = [
        { key: "roles.reviewer.enabled", path: "src/contracts/index.ts", line: 1, message: "unread" },
      ];
      const { remaining, problems } = applyAllowlist("settings", violations, allowlist, statusMap);
      expect(remaining).toHaveLength(0);
      expect(problems).toHaveLength(0);
    });

    it("validates until format (^R\\d+\\.\\d+$ or DEFERRED)", () => {
      const allowlist = {
        wired: [{ path: "src/cli/bench.ts", until: "INVALID_TAG" }],
      };
      const violations = [{ rule: "UNREACHABLE", path: "src/cli/bench.ts", line: 1, message: "unreachable" }];
      const { problems } = applyAllowlist("wired", violations, allowlist, statusMap);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("Invalid 'until' in allowlist entry");
    });
  });
});
