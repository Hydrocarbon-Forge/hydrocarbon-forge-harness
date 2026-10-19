import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { runSubstrate } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";

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

function getRunDir(repoDir: string, res: any): string {
  const match = res.stdout.match(/Run ID:\s+(r_[A-Z0-9]+)/);
  if (match) {
    return path.join(repoDir, ".substrate", "runs", match[1]);
  }
  return res.runDir!;
}

describe("E2E Charter and Planner Context (R4.5)", () => {
  it("carries charter and recent history into planner-request.md, excluding old versions by default", () => {
    const repo = createE2ERepo({
      "src/feature.ts": "export const featureEnabled = true;\n",
      "contracts/types.ts": "export {};\n",
    });

    try {
      // 1. Set a charter with a distinctive sentence
      const distinctiveCharterSentence =
        "The project stands for deterministic orchestration and zero hallucinated diffs.";
      const charterFile = path.join(repo.dir, "my-charter.md");
      fs.writeFileSync(
        charterFile,
        `# Core Charter\n\n${distinctiveCharterSentence}\n`,
        "utf8"
      );

      const setRes = runSubstrate({
        repo,
        args: ["charter", "set", "my-charter.md"],
      });
      expect(setRes.exitCode).toBe(0);

      // Verify charter show
      const showRes = runSubstrate({
        repo,
        args: ["charter", "show"],
      });
      expect(showRes.exitCode).toBe(0);
      expect(showRes.stdout).toContain(distinctiveCharterSentence);

      // 2. Creates one archived run with run (fake solo scenario)
      const distinctiveGoal = "Implement distinctive solo worker goal 987654";
      const soloRes = runSubstrate({
        repo,
        scenario: {
          calls: [
            {
              edits: { "src/feature.txt": "created\n" },
              reply: "DONE",
            },
          ],
        },
        args: [
          "run",
          "--mode",
          "solo",
          "--verify",
          "test -f src/feature.txt",
          distinctiveGoal,
        ],
      });
      expect(soloRes.exitCode).toBe(0);

      // Verify solo run was archived into v1
      const archiveDirV1 = path.join(repo.dir, ".substrate", "archive", "v1");
      const indexPathV1 = path.join(archiveDirV1, "INDEX.md");
      expect(fs.existsSync(indexPathV1)).toBe(true);
      const indexV1Content = fs.readFileSync(indexPathV1, "utf8");
      expect(indexV1Content).toContain(distinctiveGoal);

      // 3. Runs plan with fake planner
      const planRes1 = runSubstrate({
        repo,
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
              reply: "wrote manifest.yaml and task spec\nPLAN READY",
            },
          ],
        },
        args: [
          "plan",
          "--permission-mode",
          "plan",
          "First planning request goal",
        ],
      });
      expect(planRes1.exitCode).toBe(0);
      expect(planRes1.runDir).toBeDefined();

      const runDir1 = getRunDir(repo.dir, planRes1);
      const reqPath1 = path.join(runDir1, "planner-request.md");
      expect(fs.existsSync(reqPath1)).toBe(true);
      const reqContent1 = fs.readFileSync(reqPath1, "utf8");
      expect(reqContent1).toContain(distinctiveCharterSentence);
      expect(reqContent1).toContain(distinctiveGoal);

      // 4. Runs charter bump v2
      const bumpRes = runSubstrate({
        repo,
        args: ["charter", "bump", "v2"],
      });
      expect(bumpRes.exitCode).toBe(0);
      expect(bumpRes.stdout).toContain("charter now at v2");

      // Verify v2 INDEX.md exists and is empty
      const indexPathV2 = path.join(repo.dir, ".substrate", "archive", "v2", "INDEX.md");
      expect(fs.existsSync(indexPathV2)).toBe(true);

      // 5. Next plan without --history-all does not contain the v1 run's goal
      const planRes2 = runSubstrate({
        repo,
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
              reply: "wrote manifest.yaml and task spec\nPLAN READY",
            },
          ],
        },
        args: [
          "plan",
          "--permission-mode",
          "plan",
          "Second planning request goal",
        ],
      });
      expect(planRes2.exitCode).toBe(0);

      const runDir2 = getRunDir(repo.dir, planRes2);
      const reqPath2 = path.join(runDir2, "planner-request.md");
      expect(fs.existsSync(reqPath2)).toBe(true);
      const reqContent2 = fs.readFileSync(reqPath2, "utf8");
      expect(reqContent2).toContain(distinctiveCharterSentence);
      // Older v1 run goal must NOT be present
      expect(reqContent2).not.toContain(distinctiveGoal);

      // 6. Plan with --history-all DOES contain the v1 run's goal
      const planRes3 = runSubstrate({
        repo,
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
              reply: "wrote manifest.yaml and task spec\nPLAN READY",
            },
          ],
        },
        args: [
          "plan",
          "--history-all",
          "--permission-mode",
          "plan",
          "Third planning request goal with history all",
        ],
      });
      expect(planRes3.exitCode).toBe(0);

      const runDir3 = getRunDir(repo.dir, planRes3);
      const reqPath3 = path.join(runDir3, "planner-request.md");
      expect(fs.existsSync(reqPath3)).toBe(true);
      const reqContent3 = fs.readFileSync(reqPath3, "utf8");
      expect(reqContent3).toContain(distinctiveCharterSentence);
      // With --history-all, v1 run goal IS present
      expect(reqContent3).toContain(distinctiveGoal);
    } finally {
      repo.cleanup();
    }
  });
});
