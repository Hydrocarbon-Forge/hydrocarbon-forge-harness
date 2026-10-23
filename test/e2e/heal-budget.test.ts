import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";

const RUN_ARGS = [
  "run",
  "--permission-mode",
  "bypassPermissions",
  "Run the heal, budget, timeout and rate limit case",
];

const CONTRACT_STUB = "export {};\n";

function manifestFor(runId: string, goal: string): string {
  return [
    "version: 1",
    `run_id: ${runId}`,
    `goal: ${goal}`,
    "base_ref: main",
    "ecosystem: node-ts",
    "setup:",
    "  - run: echo setup",
    "    timeout_s: 30",
    "contracts:",
    "  files:",
    "    - contracts/types.ts",
    "  typecheck:",
    "    - run: echo typecheck contracts",
    "      timeout_s: 30",
    "integration_verify:",
    "  - run: echo verify all",
    "    timeout_s: 60",
    "tasks:",
    "  - id: T1",
    "    spec: tasks/T1.md",
    "",
  ].join("\n");
}

function taskSpec(options: {
  verify: string;
  budgetLines?: string[];
}): string {
  const budget = options.budgetLines ?? ["  max_usd: 0.5", "  max_turns: 12"];

  return [
    "---",
    "id: T1",
    "title: Heal, budget, timeout or rate limit",
    "class: feature",
    "depends_on: []",
    "read:",
    "  - contracts/types.ts",
    "write:",
    "  - src/feature.txt",
    "create: []",
    "protected: []",
    "budget:",
    ...budget,
    "verify:",
    `  - run: ${options.verify}`,
    "    timeout_s: 10",
    "---",
    "",
    "## Objective",
    "",
    "Write one line in the allowed file and nothing else.",
    "",
    "## Interface",
    "",
    "The allowed file gains the marker line.",
    "",
    "## Behavior",
    "",
    "The marker line is present after the task runs.",
    "",
    "## Invariants",
    "",
    "No other file is modified.",
    "",
    "## Edge cases",
    "",
    "The file is not rewritten, only appended.",
    "",
    "## Guardrails",
    "",
    "No network access.",
    "",
    "## Out of scope",
    "",
    "Renaming the file.",
    "",
  ].join("\n");
}

function planCall(manifest: string, spec: string, finishLine = "PLAN READY"): Record<string, unknown> {
  return {
    plan: {
      files: {
        "manifest.yaml": manifest,
        "tasks/T1.md": spec,
        "contracts/types.ts": CONTRACT_STUB,
      },
    },
    reply: `wrote the plan for the heal and budget case\n${finishLine}`,
  };
}

interface RunEventLike {
  type: string;
  data?: Record<string, unknown>;
}

function eventsOfType(res: RunSubstrateResult, type: string): RunEventLike[] {
  return res.events
    .filter((e) => e.type === type)
    .map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

describe("E2E heal, budgets, timeouts, rate limits (R3.4)", () => {
  it(
    "(a) verify failure on attempt 1 heals once with the real failing VerifyResults",
    () => {
      const manifest = manifestFor("r_AAAAAAAAAAAA", "Heal after a failing verify");
      const spec = taskSpec({
        // The failing verify writes its reason to stderr, so the heal prompt renders
        // real VerifyResults rather than a hard-coded sentence.
        verify: "grep -q marker src/feature.txt || (echo missing-marker 1>&2; exit 1)",
      });

      const res = runSubstrate({
        files: {
          "src/feature.txt": "seed\n",
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall(manifest, spec),
            // Attempt 1: the edit does not satisfy verify.
            {
              edits: { "src/feature.txt": "seed\nthe-wrong-line\n" },
              reply: "appended a line without the marker\nDONE",
            },
            // The one L0 heal: the same session fixes the file.
            {
              edits: { "src/feature.txt": "seed\nthe-wrong-line\nmarker\n" },
              reply: "the heal fixes the marker\nDONE",
            },
          ],
        },
        args: RUN_ARGS,
      });

      try {
        const healing = eventsOfType(res, "task.healing");
        expect(healing).toHaveLength(1);

        const failures = String(healing[0].data?.failures ?? "");
        expect(failures).toContain("Command: grep -q marker");
        expect(failures).toContain("Exit code: 1");
        expect(failures).toContain("Stderr:");
        expect(failures).toContain("missing-marker");
        expect(Buffer.byteLength(failures)).toBeLessThanOrEqual(8192);
        expect(healing[0].data?.attempt).toBe(2);
        expect(healing[0].data?.task_id).toBe("T1");

        // The heal resumes the attempt 1 session, it does not start a new one.
        const started = eventsOfType(res, "task.session.started");
        expect(healing[0].data?.session_id).toBe(started[0]?.data?.session_id);

        expect(eventsOfType(res, "task.passed")).toHaveLength(1);
        expect(res.exitCode).toBe(0);
      } finally {
        res.cleanup();
      }
    },
    60000
  );

  it(
    "(d) four rate limits back off, halve concurrency from 8, and pause the run with exit code 3",
    () => {
      const manifest = manifestFor("r_FFFFFFFFFFFF", "Back off on rate limits and pause");
      const spec = taskSpec({ verify: "grep -q marker src/feature.txt" });

      const res = runSubstrate({
        files: {
          "src/feature.txt": "seed\n",
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall(manifest, spec),
            { failure: "rate_limit", reply: "rate limit 1" },
            { failure: "rate_limit", reply: "rate limit 2" },
            { failure: "rate_limit", reply: "rate limit 3" },
            { failure: "rate_limit", reply: "rate limit 4" },
          ],
        },
        args: RUN_ARGS,
        settings: { concurrency: { workers: 8 } },
      });

      try {
        const backoffs = eventsOfType(res, "rate_limit.backoff");
        expect(backoffs.length).toBeGreaterThanOrEqual(3);
        expect(backoffs.map((e) => e.data?.concurrency)).toEqual([4, 2, 1, 1]);
        expect(backoffs[0].data?.task_id).toBe("T1");

        // The same attempt is retried, so the backoff does not consume an attempt.
        const failed = eventsOfType(res, "task.failed");
        expect(failed).toHaveLength(1);
        expect(failed[0].data?.failure_class).toBe("rate_limited");
        expect(failed[0].data?.attempt).toBe(1);

        const paused = eventsOfType(res, "run.paused");
        expect(paused).toHaveLength(1);
        expect((paused[0].data as any).reason).toBe("rate_limited");
        expect(res.exitCode).toBe(3);
      } finally {
        res.cleanup();
      }
    },
    60000
  );
});
