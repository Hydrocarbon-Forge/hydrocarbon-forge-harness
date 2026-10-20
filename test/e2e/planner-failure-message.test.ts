import { describe, it, expect } from "vitest";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";

const CONTRACT_STUB = "export {};\n";

const PLAN_ARGS = ["run", "--mode", "plan", "--permission-mode", "plan"];

/** The planner's session crashes: no result event, exit code 1, one line on stderr. */
const CRASHING_PLANNER = { failure: "crash", reply: "planner crashed" };

/** Every planner attempt writes a manifest that does not parse. */
const BAD_MANIFEST_PLAN = {
  plan: { files: { "manifest.yaml": "goal: [unclosed bracket\n" } },
  reply: "drafted the plan",
};

function failedEvents(res: RunSubstrateResult): Array<{ failure_class?: string; message?: string }> {
  return res.events
    .filter((e) => e.type === "task.failed")
    .map((e) => (e.data ?? {}) as { failure_class?: string; message?: string });
}

describe("planner failure reason reaches the CLI (task.failed.message)", () => {
  it(
    "a crashed planner session names the harness reason in the text output and the event",
    () => {
      const res = runSubstrate({
        files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
        scenario: { calls: [CRASHING_PLANNER] },
        args: [...PLAN_ARGS, "Run the crashing planner case"],
      });
      try {
        expect(res.exitCode).toBe(1);
        const failed = failedEvents(res);
        expect(failed).toHaveLength(1);
        expect(failed[0].failure_class).toBe("worker_crashed");
        expect(failed[0].message).toContain("Planner session failed with exit code 1");
        expect(failed[0].message).toContain("fake-harness: simulated crash");
        expect(res.stderr).toContain("failed: worker_crashed: Planner session failed with exit code 1");
        expect(res.stderr).toContain("fake-harness: simulated crash");
      } finally {
        res.cleanup();
      }
    },
    60000
  );

  it(
    "the json output carries the same message on its task.failed event",
    () => {
      const res = runSubstrate({
        files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
        scenario: { calls: [CRASHING_PLANNER] },
        args: [...PLAN_ARGS, "--output-format", "json", "Run the crashing planner case as json"],
      });
      try {
        expect(res.exitCode).toBe(1);
        const summary = JSON.parse(res.stdout) as { events: Array<{ type: string; data?: { message?: string } }> };
        const failed = summary.events.filter((e) => e.type === "task.failed");
        expect(failed).toHaveLength(1);
        expect(failed[0].data?.message).toContain("fake-harness: simulated crash");
      } finally {
        res.cleanup();
      }
    },
    60000
  );

  it(
    "a planner that exhausts its format retries names the diagnostics in the text output",
    () => {
      const res = runSubstrate({
        files: { "src/a.txt": "seed\n", "contracts/types.ts": CONTRACT_STUB },
        scenario: { calls: [BAD_MANIFEST_PLAN, BAD_MANIFEST_PLAN, BAD_MANIFEST_PLAN] },
        args: [...PLAN_ARGS, "Run the exhausted planner case"],
      });
      try {
        expect(res.exitCode).toBe(1);
        const failed = failedEvents(res);
        expect(failed).toHaveLength(1);
        expect(failed[0].failure_class).toBe("spec_invalid");
        expect(failed[0].message?.startsWith("Planner format retries exhausted after 3 attempts: ")).toBe(true);
        expect(res.stderr).toContain("failed: spec_invalid: Planner format retries exhausted after 3 attempts: ");
      } finally {
        res.cleanup();
      }
    },
    60000
  );
});
