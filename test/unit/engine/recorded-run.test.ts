import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadSettings } from "../../../src/config/index.js";
import { type RecordedRun, recordedRunLists, recordedSettingsOverrides } from "../../../src/engine/recorded-run.js";

const FULL: RecordedRun = {
  prompt: "make a snake game",
  mode: "solo",
  permission_mode: "dontAsk",
  merge: true,
  concurrency: 2,
  max_budget_usd: 3,
  time_limit_s: 600,
  verify: ["npm test"],
  context: ["README.md"],
  permissions: { allow: ["Bash(npm test)"], deny: [] },
  sandbox: true,
  history_all: true,
  base_branch: "main",
};

describe("recordedSettingsOverrides", () => {
  it("has no verify, context or historyAll key for a fully populated run", () => {
    const out = recordedSettingsOverrides(FULL) as Record<string, unknown>;
    expect(out).not.toHaveProperty("verify");
    expect(out).not.toHaveProperty("context");
    expect(out).not.toHaveProperty("historyAll");
    expect(out.budgets).toEqual({ run: { max_usd: 3, max_wall_min: 10 } });
    expect(out.permissions).toEqual(FULL.permissions);
    expect(out.sandbox).toEqual({ enabled: true });
    expect(out.concurrency).toEqual({ workers: 2 });
  });

  it("is accepted by loadSettings as flags and keeps the recorded budget", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "substrate-recorded-run-"));
    try {
      mkdirSync(join(tmp, ".substrate"), { recursive: true });
      const settings = await loadSettings({ projectDir: tmp, flags: recordedSettingsOverrides(FULL) });
      expect(settings.budgets?.run?.max_usd).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("recordedRunLists", () => {
  it("returns both arrays and historyAll when recorded", () => {
    expect(recordedRunLists(FULL)).toEqual({ verify: ["npm test"], context: ["README.md"], historyAll: true });
  });

  it("returns an empty object for an empty run", () => {
    expect(recordedRunLists({})).toEqual({});
  });

  it("keeps an empty verify list as recorded", () => {
    expect(recordedRunLists({ verify: [] })).toEqual({ verify: [] });
  });
});
