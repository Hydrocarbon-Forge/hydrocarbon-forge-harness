import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createE2ERepo } from "./helpers/repo.js";
import { runSubstrate } from "./helpers/run-substrate.js";

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

const SEED_FILES = {
  "src/feature.ts": "export const featureEnabled = true;\n",
  "contracts/types.ts": "export {};\n",
};

describe("R4.2: Question and resume protocol", () => {
  it("case (a) plan with NEEDS INPUT scenario exits 3, JSON result has subtype needs_input and two questions", () => {
    const repo = createE2ERepo(SEED_FILES);
    try {
      const scenario = {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
                "QUESTIONS.md": [
                  "1. Which cache layer should the helper use?",
                  "   Default: memory",
                  "2. Should telemetry be enabled?",
                  "   Default: false",
                ].join("\n"),
              },
            },
            reply: "I cannot choose without more information\nNEEDS INPUT",
          },
        ],
      };

      const res = runSubstrate({
        repo,
        scenario,
        args: ["plan", "--output-format", "json", "Add the feature helper"],
      });

      expect(res.exitCode).toBe(3);
      const result = JSON.parse(res.stdout);
      expect(result.subtype).toBe("needs_input");
      expect(result.run_id).toBeTruthy();
      expect(result.questions).toHaveLength(2);
      expect(result.questions[0]).toEqual({
        id: "Q1",
        text: "Which cache layer should the helper use?",
        default: "memory",
      });
      expect(result.questions[1]).toEqual({
        id: "Q2",
        text: "Should telemetry be enabled?",
        default: "false",
      });
    } finally {
      repo.cleanup();
    }
  });

  it("case (b) resume <run> --answers <file> continues with second scenario that finishes PLAN READY and exits 0", () => {
    const repo = createE2ERepo(SEED_FILES);
    try {
      const scenarioPause = {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
                "QUESTIONS.md": [
                  "1. Which cache layer should the helper use?",
                  "   Default: memory",
                  "2. Should telemetry be enabled?",
                  "   Default: false",
                ].join("\n"),
              },
            },
            reply: "I need input\nNEEDS INPUT",
          },
        ],
      };

      const resPause = runSubstrate({
        repo,
        scenario: scenarioPause,
        args: ["plan", "--output-format", "json", "Add the feature helper"],
      });
      expect(resPause.exitCode).toBe(3);
      const parsed = JSON.parse(resPause.stdout);
      const runId = parsed.run_id;

      const answersFile = join(repo.dir, "answers.json");
      writeFileSync(
        answersFile,
        JSON.stringify({
          answers: [{ id: "Q1", text: "redis" }],
        })
      );

      const scenarioResume = {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
              },
            },
            reply: "Answers incorporated\nPLAN READY",
          },
        ],
      };

      const resResume = runSubstrate({
        repo,
        scenario: scenarioResume,
        args: ["resume", runId, "--answers", answersFile],
      });
      expect(resResume.exitCode).toBe(0);
      expect(resResume.events.some((e) => e.type === "plan.produced")).toBe(true);
      expect(resResume.events.some((e) => e.type === "contracts.committed")).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it("case (c) resume <run> with no answers uses the defaults", () => {
    const repo = createE2ERepo(SEED_FILES);
    try {
      const scenarioPause = {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
                "QUESTIONS.md": [
                  "1. Which cache layer should the helper use?",
                  "   Default: memory",
                  "2. Should telemetry be enabled?",
                  "   Default: false",
                ].join("\n"),
              },
            },
            reply: "I need input\nNEEDS INPUT",
          },
        ],
      };

      const resPause = runSubstrate({
        repo,
        scenario: scenarioPause,
        args: ["plan", "--output-format", "json", "Add the feature helper"],
      });
      expect(resPause.exitCode).toBe(3);
      const parsed = JSON.parse(resPause.stdout);
      const runId = parsed.run_id;

      const scenarioResume = {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
              },
            },
            reply: "Used defaults\nPLAN READY",
          },
        ],
      };

      const resResume = runSubstrate({
        repo,
        scenario: scenarioResume,
        args: ["resume", runId],
      });

      expect(resResume.exitCode).toBe(0);
      const resumedEvt = resResume.events.find((e) => e.type === "run.resumed");
      expect(resumedEvt).toBeDefined();
      expect((resumedEvt?.data as any)?.answers).toEqual([
        { id: "Q1", text: "memory" },
        { id: "Q2", text: "false" },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it("case (d) an answer id not in the list exits 2", () => {
    const repo = createE2ERepo(SEED_FILES);
    try {
      const scenarioPause = {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
                "QUESTIONS.md": [
                  "1. Which cache layer should the helper use?",
                  "   Default: memory",
                ].join("\n"),
              },
            },
            reply: "I need input\nNEEDS INPUT",
          },
        ],
      };

      const resPause = runSubstrate({
        repo,
        scenario: scenarioPause,
        args: ["plan", "--output-format", "json", "Add the feature helper"],
      });
      expect(resPause.exitCode).toBe(3);
      const parsed = JSON.parse(resPause.stdout);
      const runId = parsed.run_id;

      const badAnswersFile = join(repo.dir, "bad-answers.json");
      writeFileSync(
        badAnswersFile,
        JSON.stringify({
          answers: [{ id: "Q99", text: "unknown-id" }],
        })
      );

      const resResume = runSubstrate({
        repo,
        args: ["resume", runId, "--answers", badAnswersFile],
      });

      expect(resResume.exitCode).toBe(2);
      expect(resResume.stderr).toContain("Error: unknown question id Q99");
    } finally {
      repo.cleanup();
    }
  });

  it("status <run> lists pending questions when paused with needs_human", () => {
    const repo = createE2ERepo(SEED_FILES);
    try {
      const scenarioPause = {
        calls: [
          {
            plan: {
              files: {
                "manifest.yaml": MANIFEST,
                "tasks/T1.md": SPEC,
                "contracts/types.ts": CONTRACT_STUB,
                "QUESTIONS.md": [
                  "1. Which cache layer should the helper use?",
                  "   Default: memory",
                  "2. Should telemetry be enabled?",
                  "   Default: false",
                ].join("\n"),
              },
            },
            reply: "I need input\nNEEDS INPUT",
          },
        ],
      };

      const resPause = runSubstrate({
        repo,
        scenario: scenarioPause,
        args: ["plan", "--output-format", "json", "Add the feature helper"],
      });
      expect(resPause.exitCode).toBe(3);
      const parsed = JSON.parse(resPause.stdout);
      const runId = parsed.run_id;

      const resStatus = runSubstrate({
        repo,
        args: ["status", runId],
      });
      expect(resStatus.exitCode).toBe(0);
      expect(resStatus.stdout).toContain("Pending Questions:");
      expect(resStatus.stdout).toContain("[Q1] Which cache layer should the helper use? (default: memory)");
      expect(resStatus.stdout).toContain("[Q2] Should telemetry be enabled? (default: false)");
    } finally {
      repo.cleanup();
    }
  });
});
