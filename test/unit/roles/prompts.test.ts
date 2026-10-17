import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";

// Import prompt builders using typed dynamic import for compilation safety
export interface PlannerPromptOptions {
  request: string;
  repoMap: string;
  instructionFiles?: string[];
  skillsList?: Array<{ name: string; description: string }>;
}

export interface TestWriterPromptOptions {
  specContent: string;
  contractStubs: Array<{ path: string; content: string }>;
}

const { buildPlannerPrompt } = (await import(
  "../../../src/roles/prompts/planner.js" as any
)) as {
  buildPlannerPrompt: (opts: PlannerPromptOptions) => { system: string; user: string };
};

const { buildWorkerPrompt } = (await import(
  "../../../src/roles/prompts/worker.js" as any
)) as {
  buildWorkerPrompt: (specAbsPath: string) => { system: string; user: string };
};

const { buildTestWriterPrompt } = (await import(
  "../../../src/roles/prompts/test-writer.js" as any
)) as {
  buildTestWriterPrompt: (opts: TestWriterPromptOptions) => { system: string; user: string };
};

const { buildReviewerPrompt } = (await import(
  "../../../src/roles/prompts/reviewer.js" as any
)) as {
  buildReviewerPrompt: (diff: string, contracts: string[]) => { system: string; user: string };
};

const { buildReplanPrompt } = (await import(
  "../../../src/roles/prompts/replan.js" as any
)) as {
  buildReplanPrompt: (
    packet: Contracts.FailurePacket,
    decisionsLog?: string,
  ) => { system: string; user: string };
};

describe("Role Prompt Builders (src/roles/prompts/**)", () => {
  describe("Planner Prompt (buildPlannerPrompt)", () => {
    const baseOpts: PlannerPromptOptions = {
      request: "Add user profile settings endpoint",
      repoMap: "src/\n  index.ts\n  users.ts",
    };

    it("generates system and user prompts with request and structural repo map", () => {
      const prompt = buildPlannerPrompt(baseOpts);

      expect(prompt).toHaveProperty("system");
      expect(prompt).toHaveProperty("user");
      expect(prompt.user).toContain(baseOpts.request);
      expect(prompt.user).toContain("src/\n  index.ts\n  users.ts");
    });

    it("enforces progressive disclosure of skills: discloses ONLY skill names and descriptions", () => {
      const skills = [
        { name: "git-commit-helper", description: "Formats git commits" },
        { name: "test-runner", description: "Runs vitest suites" },
      ];
      const withSkills = buildPlannerPrompt({ ...baseOpts, skillsList: skills });

      expect(withSkills.user).toContain("git-commit-helper");
      expect(withSkills.user).toContain("Formats git commits");
      expect(withSkills.user).toContain("test-runner");
      expect(withSkills.user).toContain("Runs vitest suites");

      const withoutSkills = buildPlannerPrompt({ ...baseOpts, skillsList: undefined });
      expect(withoutSkills.user).not.toContain("git-commit-helper");
      expect(withoutSkills.user).not.toContain("Skills:");
    });

    it("includes instruction files when provided, omits section when absent", () => {
      const instructions = ["docs/architecture.md", ".substrate/instructions.md"];
      const withInstructions = buildPlannerPrompt({
        ...baseOpts,
        instructionFiles: instructions,
      });

      expect(withInstructions.user).toContain("docs/architecture.md");
      expect(withInstructions.user).toContain(".substrate/instructions.md");

      const withoutInstructions = buildPlannerPrompt(baseOpts);
      expect(withoutInstructions.user).not.toContain("docs/architecture.md");
    });

    it("emits placeholder when repoMap is empty", () => {
      const prompt = buildPlannerPrompt({ ...baseOpts, repoMap: "" });
      expect(prompt.user).toMatch(/empty|no files/i);
    });

    it("body directs authoring manifest.yaml, task specs with required headings, and contract stubs", () => {
      const prompt = buildPlannerPrompt(baseOpts);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toMatch(/manifest\.yaml/);
      expect(combined).toMatch(/Objective/);
      expect(combined).toMatch(/Interface/);
      expect(combined).toMatch(/Behavior/);
      expect(combined).toMatch(/Invariants/);
      expect(combined).toMatch(/Edge cases/);
      expect(combined).toMatch(/Guardrails/);
      expect(combined).toMatch(/Out of scope/);
    });

    it("strictly forbids implementation bodies in planner output", () => {
      const prompt = buildPlannerPrompt(baseOpts);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toMatch(/forbid(den)?.*implementation/i);
    });
  });

  describe("Worker Prompt (buildWorkerPrompt)", () => {
    it("returns exact canonical one-sentence prompt (§7)", () => {
      const absPath = "/home/user/project/.substrate/runs/r_234567890123/tasks/T1.md";
      const expectedSentence = `Execute the task spec at ${absPath}. Work only in the current directory. Do not run git commit/push/checkout/reset. Reply with one line: DONE or BLOCKED: <reason>.`;

      const prompt = buildWorkerPrompt(absPath);
      expect(prompt.user.trim()).toBe(expectedSentence);
    });

    it("throws error when specAbsPath is relative or unsafe", () => {
      expect(() => buildWorkerPrompt("tasks/T1.md")).toThrow(/absolute/i);
      expect(() => buildWorkerPrompt("./tasks/T1.md")).toThrow(/absolute/i);
      expect(() => buildWorkerPrompt("../tasks/T1.md")).toThrow(/absolute/i);
      expect(() => buildWorkerPrompt("")).toThrow();
    });
  });

  describe("Test-Writer Prompt (buildTestWriterPrompt)", () => {
    const validOpts: TestWriterPromptOptions = {
      specContent: `---
id: T1
title: Auth login
class: feature
depends_on: []
read: []
write: ["src/auth.ts"]
create: ["test/auth.test.ts"]
protected: []
verify:
  - run: "npm test -- test/auth.test.ts"
    timeout_s: 30
---
## Objective
Implement auth login function.
`,
      contractStubs: [
        {
          path: "src/auth.ts",
          content: "export declare function login(user: string): Promise<boolean>;",
        },
      ],
    };

    it("formats prompt with acceptance criteria from verify section and stub declarations", () => {
      const prompt = buildTestWriterPrompt(validOpts);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toContain("npm test -- test/auth.test.ts");
      expect(combined).toContain("export declare function login");
      expect(combined).toContain("src/auth.ts");
    });

    it("instructs test-writer to create new test files only and forbids modifying application source code", () => {
      const prompt = buildTestWriterPrompt(validOpts);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toMatch(/test files only|create tests/i);
      expect(combined).toMatch(/forbid|never modify.*application|source code/i);
    });

    it("throws error when specContent or contractStubs are missing or empty", () => {
      expect(() =>
        buildTestWriterPrompt({ ...validOpts, specContent: "" }),
      ).toThrow(/missing.*spec/i);

      expect(() =>
        buildTestWriterPrompt({ ...validOpts, contractStubs: [] }),
      ).toThrow(/missing.*contract/i);
    });
  });

  describe("Reviewer Prompt (buildReviewerPrompt)", () => {
    it("constructs prompt containing diff statistics, patch lines, and contract expectations", () => {
      const diff = `--- a/src/user.ts
+++ b/src/user.ts
@@ -1,2 +1,3 @@
 export function getUser() {
+  return { id: 1, name: "Alice" };
 }`;
      const contracts = ["src/contracts/user.ts"];

      const prompt = buildReviewerPrompt(diff, contracts);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toContain(diff);
      expect(combined).toContain("src/contracts/user.ts");
      expect(combined).toMatch(/verify|review/i);
      expect(combined).toMatch(/invariant|scope/i);
    });

    it("instructs reviewer to emit structured review report and check scope isolation", () => {
      const prompt = buildReviewerPrompt("empty diff", []);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toMatch(/report|verdict/i);
      expect(combined).toMatch(/scope/i);
    });
  });

  describe("Replan Prompt (buildReplanPrompt)", () => {
    const baseFailurePacket: Contracts.FailurePacket = {
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

    it("formats verify_failed failure class with verify command tails, exit codes, and diff", () => {
      const prompt = buildReplanPrompt(baseFailurePacket);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toContain("verify_failed");
      expect(combined).toContain("AssertionError: expected false to be true");
      expect(combined).toContain("npm test -- test/auth.test.ts");
      expect(combined).toContain("exit_code: 1");
    });

    it("formats scope_violation failure class by listing offending file paths and instructing scope narrowing", () => {
      const scopePacket: Contracts.FailurePacket = {
        ...baseFailurePacket,
        failure_class: "scope_violation",
        scope_violations: ["src/unauthorized.ts", "package.json"],
      };

      const prompt = buildReplanPrompt(scopePacket);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toContain("scope_violation");
      expect(combined).toContain("src/unauthorized.ts");
      expect(combined).toContain("package.json");
      expect(combined).toMatch(/narrow.*scope|scope violation/i);
    });

    it("formats protected_modified failure class by instructing preserving files byte-identical", () => {
      const protectedPacket: Contracts.FailurePacket = {
        ...baseFailurePacket,
        failure_class: "protected_modified",
        scope_violations: ["test/unit/auth.test.ts"],
      };

      const prompt = buildReplanPrompt(protectedPacket);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toContain("protected_modified");
      expect(combined).toMatch(/byte-identical|preserve.*protected/i);
    });

    it("handles truncated diff by formatting notice indicating diff truncation", () => {
      const truncatedPacket: Contracts.FailurePacket = {
        ...baseFailurePacket,
        diff: {
          ...baseFailurePacket.diff,
          truncated: true,
        },
      };

      const prompt = buildReplanPrompt(truncatedPacket);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toMatch(/diff.*truncated/i);
    });

    it("appends prior planner decisions when decisionsLog is provided", () => {
      const decisionsLog = "Task T1 assigned to low tier haiku. Split into two submodules.";
      const withLog = buildReplanPrompt(baseFailurePacket, decisionsLog);
      expect(withLog.user).toContain(decisionsLog);

      const withoutLog = buildReplanPrompt(baseFailurePacket);
      expect(withoutLog.user).not.toContain("Split into two submodules");
    });

    it("flags worker_summary as untrusted capped context", () => {
      const prompt = buildReplanPrompt(baseFailurePacket);
      const combined = `${prompt.system}\n${prompt.user}`;

      expect(combined).toMatch(/untrusted|worker summary/i);
    });
  });
});
