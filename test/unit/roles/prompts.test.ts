import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type * as Contracts from "../../../src/contracts/index.js";
import {
  buildPlannerPrompt,
  type PlannerPromptOptions,
} from "../../../src/roles/prompts/planner.js";
import { buildWorkerPrompt } from "../../../src/roles/prompts/worker.js";
import {
  buildTestWriterPrompt,
  type TestWriterPromptOptions,
} from "../../../src/roles/prompts/test-writer.js";
import { buildReplanPrompt } from "../../../src/roles/prompts/replan.js";
import { buildReviewerPrompt } from "../../../src/roles/prompts/reviewer.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Body of assets/agents/<file> with its leading YAML frontmatter removed. */
function assetAgentBody(file: string): string {
  const text = readFileSync(join(REPO_ROOT, "assets", "agents", file), "utf8");
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    return text.trim();
  }
  const end = lines.indexOf("---", 1);
  return (end === -1 ? text : lines.slice(end + 1).join("\n")).trim();
}

function assetFirstLine(file: string): string {
  return readFileSync(
    join(REPO_ROOT, "assets", "prompts", file),
    "utf8",
  )
    .split("\n")[0]
    .trim();
}

describe("Role prompt builders (src/roles/prompts/**)", () => {
  describe("Worker prompt (buildWorkerPrompt)", () => {
    it("renders the absolute spec path into the user prompt", () => {
      const prompt = buildWorkerPrompt("/abs/spec.md");
      expect(prompt.user).toContain("/abs/spec.md");
      expect(prompt.user).not.toContain("{{");
    });

    it("assembles a system prompt from assets, not from code", () => {
      const prompt = buildWorkerPrompt("/abs/spec.md");
      expect(prompt.system.length).toBeGreaterThan(0);
      expect(prompt.system).not.toContain("{{");
      // The worker agent body never carries the "You are the Substrate ..."
      // literal that the other role bodies do.
      expect(prompt.system).not.toContain("You are the Substrate");
      expect(prompt.system).toContain(assetAgentBody("worker.md").split("\n")[0]);
    });

    it("throws when the spec path is relative or empty", () => {
      expect(() => buildWorkerPrompt("tasks/T1.md")).toThrow(/absolute/i);
      expect(() => buildWorkerPrompt("./tasks/T1.md")).toThrow(/absolute/i);
      expect(() => buildWorkerPrompt("../tasks/T1.md")).toThrow(/absolute/i);
      expect(() => buildWorkerPrompt("")).toThrow(/absolute/i);
    });
  });

  describe("Planner prompt (buildPlannerPrompt)", () => {
    const baseOpts: PlannerPromptOptions = {
      request: "Add user profile settings endpoint",
      repoMap: "src/\n  index.ts\n  users.ts",
    };

    it("renders the request and repo map into the user prompt", () => {
      const prompt = buildPlannerPrompt(baseOpts);
      expect(prompt.user).toContain(baseOpts.request);
      expect(prompt.user).toContain("src/\n  index.ts\n  users.ts");
      expect(prompt.user).not.toContain("{{");
    });

    it("renders variables the caller does not have as (none)", () => {
      const prompt = buildPlannerPrompt(baseOpts);
      expect(prompt.user).toContain("- run_id: (none)");
      expect(prompt.user).toContain("- base_ref: (none)");
    });

    it("renders instruction files as '- ' lines and omits them when absent", () => {
      const withInstructions = buildPlannerPrompt({
        ...baseOpts,
        instructionFiles: ["docs/architecture.md", ".substrate/instructions.md"],
      });
      expect(withInstructions.user).toContain("- docs/architecture.md");
      expect(withInstructions.user).toContain("- .substrate/instructions.md");

      const withoutInstructions = buildPlannerPrompt(baseOpts);
      expect(withoutInstructions.user).not.toContain("docs/architecture.md");
    });

    it("renders skills as '- ' lines with name and description", () => {
      const withSkills = buildPlannerPrompt({
        ...baseOpts,
        skillsList: [
          { name: "git-commit-helper", description: "Formats git commits" },
        ],
      });
      expect(withSkills.user).toContain("- git-commit-helper: Formats git commits");

      const withoutSkills = buildPlannerPrompt(baseOpts);
      expect(withoutSkills.user).not.toContain("git-commit-helper");
    });

    it("assembles the system prompt from the planner agent body and the format reference", () => {
      const prompt = buildPlannerPrompt(baseOpts);
      expect(prompt.system).not.toContain("{{");
      expect(prompt.system).toContain("manifest.yaml");
      expect(prompt.system).toContain(assetAgentBody("planner.md").split("\n")[0]);
      expect(prompt.system).toContain(assetFirstLine("planner/format.md"));
    });
  });

  describe("Test-writer prompt (buildTestWriterPrompt)", () => {
    const validOpts: TestWriterPromptOptions = {
      specContent: "## Objective\nImplement auth login function.\n",
      contractStubs: [
        {
          path: "src/auth.ts",
          content: "export declare function login(user: string): Promise<boolean>;",
        },
      ],
    };

    it("renders the task template with no placeholders left and empty variables as (none)", () => {
      const prompt = buildTestWriterPrompt(validOpts);
      expect(prompt.user).not.toContain("{{");
      expect(prompt.user).toContain("(none)");
    });

    it("assembles the system prompt from the worker and test-writer agent bodies", () => {
      const prompt = buildTestWriterPrompt(validOpts);
      expect(prompt.system).not.toContain("{{");
      expect(prompt.system).toContain(assetAgentBody("worker.md").split("\n")[0]);
      expect(prompt.system).toContain(assetAgentBody("test-writer.md").split("\n")[0]);
    });

    it("throws when specContent is missing or empty", () => {
      expect(() =>
        buildTestWriterPrompt({ ...validOpts, specContent: "" }),
      ).toThrow(/missing.*spec/i);
      expect(() =>
        buildTestWriterPrompt({ ...validOpts, specContent: "   " }),
      ).toThrow(/missing.*spec/i);
    });

    it("throws when contractStubs are empty", () => {
      expect(() =>
        buildTestWriterPrompt({ ...validOpts, contractStubs: [] }),
      ).toThrow(/missing.*contract/i);
    });
  });

  describe("Reviewer prompt (buildReviewerPrompt)", () => {
    it("renders the diff and contract files into the user prompt", () => {
      const prompt = buildReviewerPrompt("diff-text", ["contracts/a.ts"]);
      expect(prompt.user).toContain("diff-text");
      expect(prompt.user).toContain("- contracts/a.ts");
      expect(prompt.user).not.toContain("{{");
      expect(prompt.system).not.toContain("{{");
      expect(prompt.system).toContain(assetAgentBody("reviewer.md").split("\n")[0]);
    });

    it("renders (none) for the sections the caller does not have", () => {
      const prompt = buildReviewerPrompt("d", []);
      expect(prompt.user).toContain("(none)");
      expect(prompt.user).not.toContain("{{");
    });
  });

  describe("Replan prompt (buildReplanPrompt)", () => {
    const packet: Contracts.FailurePacket = {
      run_id: "r_ABCDEF234567",
      task_id: "T1",
      generation: 1,
      failure_class: "verify_failed",
      spec_path: "tasks/T1.md",
      attempts: [],
      diff: {
        stat: "1 file changed, 2 insertions(+)",
        patch_path: "runs/r_ABCDEF234567/diff.patch",
        truncated: false,
      },
      verify_output: [
        {
          cmd: "npm test -- test/auth.test.ts",
          exit_code: 1,
          timed_out: false,
          duration_ms: 240,
          stdout_tail: "AssertionError: expected false to be true",
          stderr_tail: "Error at line 42",
          truncated: false,
        },
      ],
      scope_violations: [],
      worker_summary: "I attempted the change but test failed.",
      related_contracts: ["src/contracts/auth.ts"],
      dependents: ["T2"],
    };

    it("renders the failure packet into the user prompt", () => {
      const prompt = buildReplanPrompt(packet);
      expect(prompt.user).toContain("T1");
      expect(prompt.user).toContain("verify_failed");
      expect(prompt.user).toContain("npm test -- test/auth.test.ts");
      expect(prompt.user).toContain("AssertionError: expected false to be true");
      expect(prompt.user).not.toContain("{{");
      expect(prompt.system).not.toContain("{{");
    });

    it("lists related contracts and dependents as '- ' lines", () => {
      const user = buildReplanPrompt(packet).user;
      expect(user).toContain("- src/contracts/auth.ts");
      expect(user).toContain("- T2");
    });

    it("renders scope violations as '- scope violation: ' lines", () => {
      const scopePacket: Contracts.FailurePacket = {
        ...packet,
        scope_violations: ["src/unauthorized.ts"],
      };
      const user = buildReplanPrompt(scopePacket).user;
      expect(user).toContain("- scope violation: src/unauthorized.ts");
    });

    it("appends the decisions log when provided", () => {
      const decisionsLog = "Task T1 assigned to low tier haiku. Split into two submodules.";
      expect(buildReplanPrompt(packet, decisionsLog).user).toContain(decisionsLog);
      expect(buildReplanPrompt(packet).user).not.toContain("Split into two submodules");
    });
  });
});
