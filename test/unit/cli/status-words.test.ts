import { describe, expect, it } from "vitest";

import { headerWordOf } from "../../../src/cli/commands/status.js";

// R11.1: the text header names one status word with its reason. The JSON `status` field keeps its own values.
function recordWith(status: string, pause_reason?: string): Parameters<typeof headerWordOf>[0] {
  return { status, state: { state: "PAUSED", pause_reason, usage: { total_usd: 0 }, tasks: {} } } as any;
}

describe("R11.1: the status header word names the reason", () => {
  it.each([
    ["interrupted", undefined, "paused: stopped by you (user_cancel)"],
    ["paused", "needs_human", "paused: needs your answers"],
    ["paused", "budget_exhausted", "paused: budget"],
    ["paused", "rate_limit", "paused: rate_limit"],
    ["stopped", undefined, "stopped (process gone)"],
    ["failed", undefined, "failed"],
    ["finished", undefined, "finished"],
    ["planned", undefined, "planned"],
    ["running", undefined, "running"],
  ])("status %s (reason %s) reads %s", (status, reason, word) => {
    expect(headerWordOf(recordWith(status, reason))).toBe(word);
  });
});
