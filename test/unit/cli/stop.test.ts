import { describe, it, expect } from "vitest";

import { endRunProcess, type ProcessControl } from "../../../src/util/process-control.js";

// R10.3: endRunProcess with an injected process control. The e2e file cannot make a CLI ignore
// SIGTERM deterministically, so the --force path is exercised here: the control reports the pid
// alive until a signal ends it, and records every signal sent.

function fakeControl(args: string, endsOn: "SIGTERM" | "SIGKILL" | "never"): ProcessControl & { signals: string[] } {
  let alive = true;
  const signals: string[] = [];
  return {
    signals,
    info: () => ({ alive, args }),
    signal: (_pid, sig) => {
      signals.push(sig);
      if (sig === endsOn) alive = false;
    },
  };
}

describe("R10.3: stop signals only a Substrate process", () => {
  it("refuses a pid whose command line does not name substrate: no signal is sent", async () => {
    const control = fakeControl("sleep 100", "SIGTERM");
    const outcome = await endRunProcess(4242, { force: true, control, waitMs: 50, killWaitMs: 50 });
    expect(outcome).toBe("refused");
    expect(control.signals).toEqual([]);
  });

  it("a Substrate process that exits on SIGTERM is stopped without SIGKILL", async () => {
    const control = fakeControl("node dist/substrate.mjs run", "SIGTERM");
    const outcome = await endRunProcess(4242, { force: true, control, waitMs: 500, killWaitMs: 50 });
    expect(outcome).toBe("stopped");
    expect(control.signals).toEqual(["SIGTERM"]);
  });

  it("without --force a process still alive after the wait is left alone: not_stopped, SIGTERM only", async () => {
    const control = fakeControl("node dist/substrate.mjs run", "never");
    const outcome = await endRunProcess(4242, { force: false, control, waitMs: 50, killWaitMs: 50 });
    expect(outcome).toBe("not_stopped");
    expect(control.signals).toEqual(["SIGTERM"]);
  });

  it("with --force a process still alive after the wait gets SIGKILL and is killed", async () => {
    const control = fakeControl("node dist/substrate.mjs run", "SIGKILL");
    const outcome = await endRunProcess(4242, { force: true, control, waitMs: 50, killWaitMs: 500 });
    expect(outcome).toBe("killed");
    expect(control.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("a pid that is gone before the stop is reported as stopped, with no signal", async () => {
    const control: ProcessControl & { signals: string[] } = {
      signals: [],
      info: () => ({ alive: false, args: "" }),
      signal: () => {
        throw new Error("must not signal");
      },
    };
    expect(await endRunProcess(4242, { force: true, control })).toBe("stopped");
  });
});
