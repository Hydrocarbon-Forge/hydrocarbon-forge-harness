import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";

/**
 * Plan content the fake planner writes into the run directory. The run id inside the
 * manifest is a fixed valid id because the CLI generates its own per run.
 */
const MANIFEST = [
  "version: 1",
  "run_id: r_CCCCCCCCCCCC",
  "goal: Add the feature helper",
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
  "budget:",
  "  max_usd: 5",
  "  max_tokens: 200000",
  "  max_wall_min: 30",
  "",
].join("\n");

const SPEC = [
  "---",
  "id: T1",
  "title: Add feature helper",
  "class: feature",
  "depends_on: []",
  "read:",
  "  - contracts/types.ts",
  "write:",
  "  - src/feature.ts",
  "create:",
  "  - src/helper.ts",
  "protected:",
  "  - contracts/types.ts",
  "budget:",
  "  max_usd: 0.5",
  "  max_turns: 12",
  "verify:",
  "  - run: grep -q runFeature src/feature.ts",
  "    timeout_s: 10",
  "---",
  "",
  "## Objective",
  "",
  "Add a helper that reports whether the feature is enabled.",
  "",
  "## Interface",
  "",
  "Export runFeature from contracts/types.ts and implement it in src/feature.ts.",
  "",
  "## Behavior",
  "",
  "The helper returns true when the enabled flag is set.",
  "",
  "## Invariants",
  "",
  "The contract file is not modified.",
  "",
  "## Edge cases",
  "",
  "An empty options object returns false.",
  "",
  "## Guardrails",
  "",
  "No network access.",
  "",
  "## Out of scope",
  "",
  "Caching and CLI wiring.",
  "",
].join("\n");

const CONTRACT_STUB = "export declare function runFeature(name: string): boolean;\n";

const PLAN_ARGS = [
  "run",
  "--mode",
  "plan",
  "--permission-mode",
  "plan",
  "Add the feature helper",
];

function eventsOfType(res: RunSubstrateResult, type: string) {
  return res.events.filter((e) => e.type === type);
}

describe("E2E planner: the finish line decides the run (R3.1)", () => {
  it("(a) a valid plan emits plan.produced and the plan-mode run exits 0", () => {
    const res = runSubstrate({
      files: {
        "src/feature.ts": "export const featureEnabled = true;\n",
        "contracts/types.ts": "export {};\n",
      },
      scenario: {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
              },
            },
            reply: "wrote manifest.yaml and the task spec\nPLAN READY",
          },
        ],
      },
      args: PLAN_ARGS,
    });

    try {
      expect(res.exitCode).toBe(0);

      const produced = eventsOfType(res, "plan.produced");
      expect(produced.length).toBe(1);
      const producedData = produced[0]?.data as {
        manifest?: { tasks?: Array<{ id: string }> };
        commit_sha?: string;
      };
      expect(producedData?.manifest?.tasks?.[0]?.id).toBe("T1");
      expect(producedData?.commit_sha).toMatch(/^[0-9a-f]{40}$/);

      // The lint action reports every diagnostic, and this plan has none.
      const lint = eventsOfType(res, "plan.lint");
      expect(lint.length).toBe(1);
      const lintData = lint[0]?.data as { valid?: boolean; diagnostics?: unknown[] };
      expect(lintData?.valid).toBe(true);
      expect(lintData?.diagnostics).toEqual([]);

      expect(eventsOfType(res, "plan.ready").length).toBe(1);
      const finished = eventsOfType(res, "run.finished").pop();
      expect((finished?.data as { exit_code?: number })?.exit_code).toBe(0);

      // The planner commits its contract stubs to the run branch.
      const committed = eventsOfType(res, "contracts.committed");
      expect(committed.length).toBe(1);
      expect((committed[0]?.data as { commit_sha?: string })?.commit_sha).toBe(
        producedData?.commit_sha
      );
    } finally {
      res.cleanup();
    }
  });

  it("(b) a rejected manifest is corrected in the same session and both attempts record usage", () => {
    const res = runSubstrate({
      files: {
        "src/feature.ts": "export const featureEnabled = true;\n",
        "contracts/types.ts": "export {};\n",
      },
      scenario: {
        calls: [
          {
            plan: { files: { "manifest.yaml": "goal: [unclosed bracket\n" } },
            reply: "drafted the plan, please review",
          },
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
              },
            },
            reply: "corrected manifest.yaml\nPLAN READY",
          },
        ],
      },
      args: PLAN_ARGS,
    });

    try {
      expect(res.exitCode).toBe(0);

      const usage = eventsOfType(res, "usage.recorded");
      expect(usage.length).toBe(2);
      expect(usage.every((e) => (e.data as { role?: string })?.role === "planner")).toBe(true);

      // The corrected plan is the one the run reports.
      const produced = eventsOfType(res, "plan.produced");
      expect(produced.length).toBe(1);
      expect((produced[0]?.data as { manifest?: { goal?: string } })?.manifest?.goal).toBe(
        "Add the feature helper"
      );

      // The retry resumes the same planner session.
      expect(res.runDir).not.toBeNull();
    } finally {
      res.cleanup();
    }
  });

  it("(c) NEEDS INPUT with QUESTIONS.md pauses the run and exits 3", () => {
    const res = runSubstrate({
      files: {
        "src/feature.ts": "export const featureEnabled = true;\n",
        "contracts/types.ts": "export {};\n",
      },
      scenario: {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
                "QUESTIONS.md": "Which cache layer should the helper use?\n",
              },
            },
            reply: "I cannot choose the cache layer without more information\nNEEDS INPUT",
          },
        ],
      },
      args: PLAN_ARGS,
    });

    try {
      expect(res.exitCode).toBe(3);

      const paused = eventsOfType(res, "run.paused");
      expect(paused.length).toBe(1);
      const pausedData = paused[0]?.data as {
        reason?: string;
        questions_path?: string;
        session_id?: string;
      };
      expect(pausedData?.reason).toBe("needs_human");
      expect(pausedData?.questions_path).toBe(join(res.runDir ?? "", "QUESTIONS.md"));
      expect(pausedData?.session_id).toBeTruthy();

      // The questions file is on disk in the run directory.
      expect(res.runDir).not.toBeNull();
      expect(existsSync(join(res.runDir ?? "", "QUESTIONS.md"))).toBe(true);

      // A paused plan does not commit contract stubs.
      expect(eventsOfType(res, "contracts.committed").length).toBe(0);
    } finally {
      res.cleanup();
    }
  });
});
