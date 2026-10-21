import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { parseEngineEvent } from "../../../src/contracts/events.js";
import { readCatalogEvents } from "../../../src/cli/commands/status.js";

// Known issue 63 (R11.2): the engine reopens a planned run for review with reason plan_review. The catalog must
// list it, or the reader the CLI uses (status, watch) drops the event as not a catalog event.

function reopenLine(reason: string): string {
  return JSON.stringify({
    v: 1,
    seq: 7,
    ts: "2026-10-21T10:00:00.000Z",
    run_id: "r_REVIEWTEST0000",
    type: "run.reopened",
    data: { reason, time_limit_s: null },
  });
}

describe("run.reopened reasons (known issue 63)", () => {
  it("the catalog accepts a reopen for plan review, with the budget and limit fields the resume records", () => {
    const event = parseEngineEvent(JSON.parse(reopenLine("plan_review")));
    expect(event.type).toBe("run.reopened");
    expect(event.data).toMatchObject({ reason: "plan_review", time_limit_s: null });
  });

  it("the catalog still refuses a reopen reason it does not list", () => {
    expect(() => parseEngineEvent(JSON.parse(reopenLine("made_up")))).toThrow();
  });

  it("the reader the CLI uses keeps a reopened-for-review event in the run's log", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-reopen-reason-"));
    try {
      const path = join(dir, "events.jsonl");
      writeFileSync(path, [reopenLine("tasks"), reopenLine("plan_review")].join("\n") + "\n", "utf8");
      const stderr = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
      const events = readCatalogEvents(path, stderr);
      expect(events.map((e) => (e.data as { reason?: string }).reason)).toEqual(["tasks", "plan_review"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
