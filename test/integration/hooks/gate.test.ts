import { describe, expect, it } from "vitest";

import type * as Contracts from "../../../src/contracts/index.js";
import type { HookResult } from "./runner.test.js";

export interface HookGateResult {
  proceed: boolean;
  blockedBy?: HookResult;
  feedback?: string;
}

async function loadGateModule(): Promise<{
  evaluateHookGate: (
    event: "PostPlan" | "PreMerge" | "PreRun" | "PreTask",
    results: HookResult[]
  ) => HookGateResult;
}> {
  return (await import("../../../src/hooks/gate.js" as any)) as any;
}

function makeResult(overrides: Partial<HookResult>): HookResult {
  return {
    command: "echo test",
    exit_code: 0,
    blocked: false,
    stderr: "",
    stdout: "",
    timed_out: false,
    duration_ms: 10,
    ...overrides,
  };
}

describe("hooks gate evaluation", () => {
  const blockingEvents: Array<"PreRun" | "PostPlan" | "PreTask" | "PreMerge"> = [
    "PreRun",
    "PostPlan",
    "PreTask",
    "PreMerge",
  ];

  describe.each(blockingEvents)("gate evaluation for event: %s", (event) => {
    it("returns proceed: true when results array is empty (no hooks configured)", async () => {
      const { evaluateHookGate } = await loadGateModule();

      const gate = evaluateHookGate(event, []);
      expect(gate.proceed).toBe(true);
      expect(gate.blockedBy).toBeUndefined();
      expect(gate.feedback).toBeUndefined();
    });

    it("returns proceed: true when all hooks succeeded with exit_code: 0", async () => {
      const { evaluateHookGate } = await loadGateModule();

      const results: HookResult[] = [
        makeResult({ command: "check-lint", exit_code: 0, blocked: false }),
        makeResult({ command: "check-types", exit_code: 0, blocked: false }),
      ];

      const gate = evaluateHookGate(event, results);
      expect(gate.proceed).toBe(true);
      expect(gate.blockedBy).toBeUndefined();
    });

    it("returns proceed: false with feedback when a hook returned exit_code: 2 (blocked: true)", async () => {
      const { evaluateHookGate } = await loadGateModule();

      const blockedResult = makeResult({
        command: "security-gate",
        exit_code: 2,
        blocked: true,
        stderr: "Security policy violated: forbidden network call planned",
      });

      const results: HookResult[] = [
        makeResult({ command: "lint", exit_code: 0, blocked: false }),
        blockedResult,
      ];

      const gate = evaluateHookGate(event, results);
      expect(gate.proceed).toBe(false);
      expect(gate.blockedBy).toBe(blockedResult);
      expect(gate.feedback).toBe("Security policy violated: forbidden network call planned");
    });

    it("synthesizes feedback when hook exits 2 with empty stderr", async () => {
      const { evaluateHookGate } = await loadGateModule();

      const blockedResult = makeResult({
        command: "silent-blocker",
        exit_code: 2,
        blocked: true,
        stderr: "",
      });

      const gate = evaluateHookGate(event, [blockedResult]);
      expect(gate.proceed).toBe(false);
      expect(gate.blockedBy).toBe(blockedResult);
      expect(gate.feedback).toBe("Hook command exited with code 2 but emitted no stderr");
    });

    it("does not block when a hook failed with non-zero exit code other than 2 (e.g. exit 1)", async () => {
      const { evaluateHookGate } = await loadGateModule();

      const errorResult = makeResult({
        command: "flaky-telemetry",
        exit_code: 1,
        blocked: false,
        stderr: "Telemetry network connection timeout",
      });

      const gate = evaluateHookGate(event, [errorResult]);
      expect(gate.proceed).toBe(true);
      expect(gate.blockedBy).toBeUndefined();
    });

    it("does not block when a hook timed out (timed_out: true, exit_code: null, blocked: false)", async () => {
      const { evaluateHookGate } = await loadGateModule();

      const timeoutResult = makeResult({
        command: "slow-validator",
        exit_code: null,
        blocked: false,
        timed_out: true,
        stderr: "Timed out after 30s",
      });

      const gate = evaluateHookGate(event, [timeoutResult]);
      expect(gate.proceed).toBe(true);
      expect(gate.blockedBy).toBeUndefined();
    });
  });

  describe("gate behavior across event types", () => {
    it("handles first blocking hook when multiple hooks are present", async () => {
      const { evaluateHookGate } = await loadGateModule();

      const hook1 = makeResult({ command: "h1", exit_code: 0, blocked: false });
      const hook2 = makeResult({
        command: "h2",
        exit_code: 2,
        blocked: true,
        stderr: "Blocker 1",
      });
      const hook3 = makeResult({
        command: "h3",
        exit_code: 2,
        blocked: true,
        stderr: "Blocker 2",
      });

      const gate = evaluateHookGate("PreMerge", [hook1, hook2, hook3]);
      expect(gate.proceed).toBe(false);
      expect(gate.blockedBy?.command).toBe("h2");
      expect(gate.feedback).toBe("Blocker 1");
    });
  });
});
