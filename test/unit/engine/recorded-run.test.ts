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
    expect(out.permissions).toEqual(FULL.permissions);
    expect(out.sandbox).toEqual({ enabled: true });
    expect(out.concurrency).toEqual({ workers: 2 });
  });

  it("is accepted by loadSettings as flags", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "substrate-recorded-run-"));
    try {
      mkdirSync(join(tmp, ".substrate"), { recursive: true });
      const settings = await loadSettings({ projectDir: tmp, flags: recordedSettingsOverrides(FULL) });
      expect(settings.sandbox.enabled).toBe(true);
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
