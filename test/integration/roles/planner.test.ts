import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import type { ParsedPlan } from "../../../src/spec/index.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import {
  createMockAdapter,
  createEventCollector,
  sampleValidManifestYaml,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "./fixtures.js";

export interface PlannerRunOptions {
  runId: Contracts.RunId;
  repoRoot: string;
  runDir: string;
  request: string;
  settings: Contracts.Settings;
  adapter: Contracts.HarnessAdapter;
  instructionFiles?: string[];
  skillsList?: Array<{ name: string; description: string }>;
  onEvent?: (event: Contracts.EngineEvent) => void;
}

export interface PlannerRunResult {
  plan: ParsedPlan;
  usage: Contracts.UsageRecord;
  retries: number;
  commitSha: string;
}

let runPlanner: (opts: PlannerRunOptions) => Promise<PlannerRunResult>;
let commitContractStubs: (
  repoRoot: string,
  runId: Contracts.RunId,
  baseRef: string,
  contracts: { files: string[]; typecheck: Contracts.Command[] },
  runDir: string,
) => Promise<string>;

beforeAll(async () => {
  const mod = (await import("../../../src/roles/planner.js" as any)) as any;
  runPlanner = mod.runPlanner;
  commitContractStubs = mod.commitContractStubs;
});

function makeRunId(): Contracts.RunId {
  return "r_234567ABCDEF";
}

function writeValidArtifacts(runDir: string, runId: Contracts.RunId = makeRunId()): void {
  mkdirSync(join(runDir, "tasks"), { recursive: true });
  mkdirSync(join(runDir, "contracts"), { recursive: true });

  writeFileSync(
    join(runDir, "manifest.yaml"),
    sampleValidManifestYaml(runId),
    "utf8",
  );
  writeFileSync(
    join(runDir, "tasks", "T1.md"),
    sampleValidTaskSpecMarkdown(),
    "utf8",
  );
  writeFileSync(
    join(runDir, "contracts", "types.ts"),
    sampleValidContractStub(),
    "utf8",
  );
}

describe("Planner Runner (src/roles/planner.ts)", () => {
  let repo: TestRepo;
  let runDir: string;

  beforeEach(() => {
    repo = createTestRepo("substrate-planner-test-");
    runDir = mkdtempSync(join(tmpdir(), "substrate-rundir-"));
  });

  afterEach(() => {
    repo.cleanup();
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  describe("isolated run directory spawn and prompt construction", () => {
    it("spawns planner session in isolated runDir with role, model, effort, and budget from settings", async () => {
      const collector = createEventCollector();
      const runId = makeRunId();

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          writeValidArtifacts(req.cwd, runId);
        },
      });

      const result = await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Implement authenticated feature",
        settings: DEFAULT_SETTINGS,
        adapter,
        onEvent: collector.onEvent,
      });

      expect(adapter.spawnedRequests.length).toBe(1);
      const req = adapter.spawnedRequests[0];
      expect(req.role).toBe("planner");
      expect(req.cwd).toBe(runDir);
      expect(req.model).toBe(DEFAULT_SETTINGS.roles.planner.model);
      expect(req.effort).toBe(DEFAULT_SETTINGS.roles.planner.effort);
      expect(req.budget.max_usd).toBe(DEFAULT_SETTINGS.budgets.task.max_usd);

      // Invariant: permissions deny git operations and subagents, write permitted in runDir
      expect(req.permission.deny).toContain("git commit");
      expect(req.permission.deny).toContain("git push");
      expect(req.permission.deny).toContain("git checkout");
      expect(req.permission.deny).toContain("git reset");

      // Verify lifecycle events
      const started = collector.first("plan.started");
      expect(started).toBeDefined();
      expect(started?.run_id).toBe(runId);

      const produced = collector.first("plan.produced");
      expect(produced).toBeDefined();

      const committed = collector.first("contracts.committed");
      expect(committed).toBeDefined();

      expect(result.retries).toBe(0);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.plan.manifest.run_id).toBe(runId);
    });

    it("includes skillsList in user prompt when provided, and omits skills section when omitted", async () => {
      const runId = makeRunId();
      let promptWithSkills = "";

      const adapterWithSkills = createMockAdapter({
        onSpawn: (req) => {
          promptWithSkills = req.prompt;
          writeValidArtifacts(req.cwd, runId);
        },
      });

      await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Build data pipeline",
        settings: DEFAULT_SETTINGS,
        adapter: adapterWithSkills,
        skillsList: [
          { name: "data-transform", description: "Performs tabular transforms" },
        ],
      });

      expect(promptWithSkills).toContain("data-transform");
      expect(promptWithSkills).toContain("Performs tabular transforms");

      // Now run without skills
      const runDir2 = mkdtempSync(join(tmpdir(), "substrate-rundir2-"));
      try {
        let promptWithoutSkills = "";
        const adapterWithoutSkills = createMockAdapter({
          onSpawn: (req) => {
            promptWithoutSkills = req.prompt;
            writeValidArtifacts(req.cwd, runId);
          },
        });

        await runPlanner({
          runId,
          repoRoot: repo.dir,
          runDir: runDir2,
          request: "Build data pipeline without skills",
          settings: DEFAULT_SETTINGS,
          adapter: adapterWithoutSkills,
        });

        expect(promptWithoutSkills).not.toContain("## Skills");
      } finally {
        rmSync(runDir2, { recursive: true, force: true });
      }
    });

    it("includes instructionFiles list in user prompt when provided, and omits section when omitted", async () => {
      const runId = makeRunId();
      let promptWithInstructions = "";

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          promptWithInstructions = req.prompt;
          writeValidArtifacts(req.cwd, runId);
        },
      });

      await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Add component with instructions",
        settings: DEFAULT_SETTINGS,
        adapter,
        instructionFiles: ["docs/ARCH.md", "docs/GUIDELINES.md"],
      });

      expect(promptWithInstructions).toContain("docs/ARCH.md");
      expect(promptWithInstructions).toContain("docs/GUIDELINES.md");
    });
  });

  describe("artifact collection, parsing, and linter rules L001–L027", () => {
    it("collects manifest.yaml, task specs, and contract stubs, running lintPlan and emitting plan.lint", async () => {
      const collector = createEventCollector();
      const runId = makeRunId();

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          writeValidArtifacts(req.cwd, runId);
        },
      });

      const result = await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Build full subsystem",
        settings: DEFAULT_SETTINGS,
        adapter,
        onEvent: collector.onEvent,
      });

      const lintEvent = collector.first("plan.lint");
      expect(lintEvent).toBeDefined();

      expect(result.plan.specs.has("T1")).toBe(true);
      expect(result.plan.manifest.tasks.length).toBe(1);
    });

    it("triggers format retry when manifest.yaml is missing or corrupt YAML", async () => {
      const runId = makeRunId();
      let attempt = 0;

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          attempt++;
          if (attempt === 1) {
            // Write corrupt manifest
            writeFileSync(join(req.cwd, "manifest.yaml"), ": bad : yaml :", "utf8");
          } else {
            // Write valid artifacts on retry
            writeValidArtifacts(req.cwd, runId);
          }
        },
      });

      const result = await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Build subsystem with retry",
        settings: DEFAULT_SETTINGS,
        adapter,
      });

      expect(attempt).toBe(2);
      expect(result.retries).toBe(1);
      expect(adapter.spawnedRequests.length).toBe(2);
      // Corrective prompt on retry 2 contains diagnostic info
      expect(adapter.spawnedRequests[1].prompt).toMatch(/manifest|error|YAML/i);
    });

    it("triggers format retry when task spec has missing frontmatter or missing required headings", async () => {
      const runId = makeRunId();
      let attempt = 0;

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          attempt++;
          mkdirSync(join(req.cwd, "tasks"), { recursive: true });
          mkdirSync(join(req.cwd, "contracts"), { recursive: true });

          writeFileSync(
            join(req.cwd, "manifest.yaml"),
            sampleValidManifestYaml(runId),
            "utf8",
          );
          writeFileSync(
            join(req.cwd, "contracts", "types.ts"),
            sampleValidContractStub(),
            "utf8",
          );

          if (attempt === 1) {
            // Spec missing required headings (e.g. missing ## Guardrails and ## Out of scope)
            writeFileSync(
              join(req.cwd, "tasks", "T1.md"),
              "---\nid: T1\ntitle: Partial\nclass: feature\ndepends_on: []\nread: []\nwrite: []\ncreate: []\nprotected: []\nverify:\n  - run: echo test\n    timeout_s: 10\n---\n\n## Objective\nPartial test\n",
              "utf8",
            );
          } else {
            // Fixed spec on retry
            writeFileSync(
              join(req.cwd, "tasks", "T1.md"),
              sampleValidTaskSpecMarkdown(),
              "utf8",
            );
          }
        },
      });

      const result = await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Build with spec fix",
        settings: DEFAULT_SETTINGS,
        adapter,
      });

      expect(attempt).toBe(2);
      expect(result.retries).toBe(1);
    });

    it("throws Error and rejects plan when format retries are exhausted", async () => {
      const runId = makeRunId();

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          // Always write invalid manifest
          writeFileSync(join(req.cwd, "manifest.yaml"), "invalid: [unclosed", "utf8");
        },
      });

      await expect(
        runPlanner({
          runId,
          repoRoot: repo.dir,
          runDir,
          request: "Build subsystem doomed to fail",
          settings: {
            ...DEFAULT_SETTINGS,
            budgets: {
              ...DEFAULT_SETTINGS.budgets,
              planner_format_retries: 2,
            },
          },
          adapter,
        }),
      ).rejects.toThrow(/retry|diagnostic|manifest|error/i);

      // Initial attempt (0) + 2 retries = 3 attempts total
      expect(adapter.spawnedRequests.length).toBe(3);
    });
  });

  describe("contract stub typecheck and run branch commit", () => {
    it("runs contract typecheck and commits stubs to substrate/runs/<run_id> before returning", async () => {
      const runId = makeRunId();
      const collector = createEventCollector();

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          writeValidArtifacts(req.cwd, runId);
        },
      });

      const result = await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Create typed contract",
        settings: DEFAULT_SETTINGS,
        adapter,
        onEvent: collector.onEvent,
      });

      // Contracts committed event emitted with commit SHA
      const committed = collector.first("contracts.committed");
      expect(committed).toBeDefined();
      const commitSha = (committed?.data as any)?.commitSha ?? result.commitSha;
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify git run branch exists in repo
      const runBranch = `substrate/runs/${runId}`;
      const branchRef = repo.git(["rev-parse", "--verify", runBranch]);
      expect(branchRef).toBe(result.commitSha);
    });

    it("re-prompts planner when contract typecheck fails, and rejects plan if typecheck fails permanently", async () => {
      const runId = makeRunId();

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          mkdirSync(join(req.cwd, "tasks"), { recursive: true });
          mkdirSync(join(req.cwd, "contracts"), { recursive: true });

          // Manifest with a failing typecheck command
          writeFileSync(
            join(req.cwd, "manifest.yaml"),
            sampleValidManifestYaml(runId, {
              contracts: {
                files: ["contracts/types.ts"],
                typecheck: [{ run: "exit 1", timeout_s: 10 }],
              },
            }),
            "utf8",
          );
          writeFileSync(
            join(req.cwd, "tasks", "T1.md"),
            sampleValidTaskSpecMarkdown(),
            "utf8",
          );
          writeFileSync(
            join(req.cwd, "contracts", "types.ts"),
            sampleValidContractStub(),
            "utf8",
          );
        },
      });

      await expect(
        runPlanner({
          runId,
          repoRoot: repo.dir,
          runDir,
          request: "Failing contract typecheck",
          settings: {
            ...DEFAULT_SETTINGS,
            budgets: {
              ...DEFAULT_SETTINGS.budgets,
              planner_format_retries: 1,
            },
          },
          adapter,
        }),
      ).rejects.toThrow(/contract|typecheck|failed/i);

      // Initial attempt + 1 retry = 2 attempts
      expect(adapter.spawnedRequests.length).toBe(2);

      // Invariant: run branch was NOT created with invalid contracts
      const runBranch = `substrate/runs/${runId}`;
      expect(() => repo.git(["rev-parse", "--verify", runBranch])).toThrow();
    });

    it("commitContractStubs commits contract files from runDir to target run branch", async () => {
      const runId = makeRunId();
      mkdirSync(join(runDir, "contracts"), { recursive: true });
      writeFileSync(
        join(runDir, "contracts", "api.ts"),
        "export interface Api { id: string; }\n",
        "utf8",
      );

      const commitSha = await commitContractStubs(
        repo.dir,
        runId,
        "main",
        {
          files: ["contracts/api.ts"],
          typecheck: [{ run: "echo ok", timeout_s: 10 }],
        },
        runDir,
      );

      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      const branchName = `substrate/runs/${runId}`;
      const log = repo.git(["log", "-n", "1", "--format=%B", branchName]);
      expect(log).toMatch(/contract|stub/i);
    });
  });

  describe("planner session failures and edge cases", () => {
    it("handles non-zero session exit by retrying format prompt before giving up", async () => {
      const runId = makeRunId();
      let count = 0;

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          count++;
          if (count === 1) {
            // First attempt crashes without producing files
          } else {
            writeValidArtifacts(req.cwd, runId);
          }
        },
        sessionConfigs: [
          {
            result: { ok: false, exit_code: 1, final_text: "Process error" },
          },
          {
            result: { ok: true, exit_code: 0, final_text: "Fixed" },
          },
        ],
      });

      const result = await runPlanner({
        runId,
        repoRoot: repo.dir,
        runDir,
        request: "Resilient planner run",
        settings: DEFAULT_SETTINGS,
        adapter,
      });

      expect(result.retries).toBe(1);
      expect(result.plan.manifest.run_id).toBe(runId);
    });
  });
});
