import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { createRunId } from "../../../src/util/index.js";
import type { ParsedPlan } from "../../../src/spec/index.js";
import { assembleSystem, loadTemplate } from "../../../src/prompts/index.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import {
  createMockAdapter,
  sampleValidManifestYaml,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "./fixtures.js";
import {
  PlannerFailure,
  runPlanner,
  commitContractStubs,
  finishLine,
  plannerFailureMessage,
  type PlannerEmit,
} from "../../../src/roles/planner.js";

type MockAdapter = ReturnType<typeof createMockAdapter>;

/** Collector for the planner's emit callback, which takes (type, data). */
function createEmitCollector(runId: string): {
  events: Array<{ type: string; data: unknown }>;
  onEvent: PlannerEmit;
  byType: (type: string) => Array<{ type: string; data: unknown }>;
  first: (type: string) => { type: string; data: unknown } | undefined;
} {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    events,
    onEvent<T extends string>(type: T, data: unknown) {
      events.push({ type, data });
      return {
        v: 1,
        seq: events.length,
        ts: new Date().toISOString(),
        run_id: runId,
        type,
        data,
      };
    },
    byType(type: string) {
      return events.filter((e) => e.type === type);
    },
    first(type: string) {
      return events.find((e) => e.type === type);
    },
  };
}

/** What each planner attempt writes into its run directory and replies with. */
interface Attempt {
  reply: string;
  files?: Record<string, string>;
  remove?: string[];
  ok?: boolean;
  exit_code?: number;
}

function planFiles(runId: string): Record<string, string> {
  return {
    "manifest.yaml": sampleValidManifestYaml(runId),
    "tasks/T1.md": sampleValidTaskSpecMarkdown(),
    "contracts/types.ts": sampleValidContractStub(),
  };
}

/** The `## Instruction files` section of a rendered request prompt. */
function instructionSection(prompt: string): string {
  const marker = "## Instruction files\n";
  const start = prompt.indexOf(marker);
  if (start < 0) return "";
  const rest = prompt.slice(start + marker.length);
  return rest.slice(0, rest.indexOf("\n\n"));
}

describe("Planner role (§14.5 #13, R3.1)", () => {
  let repo: TestRepo;
  let runDir: string;
  let runId: Contracts.RunId;

  beforeEach(() => {
    repo = createTestRepo("planner-");
    runDir = mkdtempSync(join(tmpdir(), "substrate-rundir-"));
    runId = createRunId();
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
    repo.cleanup();
  });

  function adapterFor(attempts: Attempt[]): MockAdapter {
    return createMockAdapter({
      nextSession: (req, index) => {
        const attempt = attempts[index];
        for (const [relPath, content] of Object.entries(attempt?.files ?? {})) {
          const full = join(req.cwd, relPath);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content, "utf8");
        }
        for (const relPath of attempt?.remove ?? []) {
          rmSync(join(req.cwd, relPath), { force: true });
        }
        return {
          result: {
            final_text: attempt?.reply ?? "PLAN READY",
            ...(attempt?.ok !== undefined ? { ok: attempt.ok } : {}),
            ...(attempt?.exit_code !== undefined ? { exit_code: attempt.exit_code } : {}),
          },
        };
      },
    });
  }

  function options(
    adapter: MockAdapter,
    extra: {
      onEvent?: PlannerEmit;
      settings?: Contracts.Settings;
      instructionFiles?: string[];
      skillsList?: Array<{ name: string; description: string }>;
    } = {}
  ) {
    return {
      runId,
      repoRoot: repo.dir,
      runDir,
      request: "Implement authenticated feature",
      settings: extra.settings ?? DEFAULT_SETTINGS,
      adapter,
      ...(extra.instructionFiles ? { instructionFiles: extra.instructionFiles } : {}),
      ...(extra.skillsList ? { skillsList: extra.skillsList } : {}),
      ...(extra.onEvent ? { onEvent: extra.onEvent } : {}),
    };
  }

  describe("first spawn request", () => {
    it("uses the prompt library for the system append and the request template", async () => {
      const adapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);

      await runPlanner(options(adapter));

      const req = adapter.spawnedRequests[0];
      expect(req.role).toBe("planner");
      expect(req.cwd).toBe(runDir);
      expect(req.model).toBe(DEFAULT_SETTINGS.roles.planner.model);
      expect(req.effort).toBe(DEFAULT_SETTINGS.roles.planner.effort);
      // R7.9: the planner is bounded by the run budget, not the per-task cap.
      expect(req.budget.max_usd).toBe(DEFAULT_SETTINGS.budgets.run.max_usd);

      // The planner is a thin wrapper over the prompt library (R1.7).
      expect(req.system_append).toBe(assembleSystem("planner", {}));
      expect(req.prompt).toContain("Implement authenticated feature");
      expect(req.prompt).toContain(`run_id: ${runId}`);

      // Invariant: the planner is denied git writes and subagents.
      expect(req.permission.deny).toContain("git commit");
      expect(req.permission.deny).toContain("git push");
      expect(req.permission.deny).toContain("git checkout");
      expect(req.permission.deny).toContain("git reset");
      expect(req.permission.deny).toContain("subagents");
      expect(req.permission.allow).toEqual([runDir]);

      // Behavior 2: the planner has no session id before the first spawn.
      expect(req.session?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(req.session?.resume).toBeUndefined();
    });

    it("reports the detected ecosystem as the first repo_map line", async () => {
      const adapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);
      await runPlanner(options(adapter));

      const prompt = adapter.spawnedRequests[0].prompt;
      expect(prompt.split("\n").some((line) => line.startsWith("Detected ecosystem:"))).toBe(true);
    });

    it("instruction files: rule 3 project lists the existing files in order, none lists none", async () => {
      const adapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);

      repo.commitFile("SUBSTRATE.md", "# Project instructions\n");
      repo.commitFile("AGENTS.md", "# Agent instructions\n");

      await runPlanner(
        options(adapter, { settings: { ...DEFAULT_SETTINGS, instructions: { workers: "project" } } })
      );

      const lines = instructionSection(adapter.spawnedRequests[0].prompt)
        .split("\n")
        .filter((line) => line.startsWith("- "));
      expect(lines).toEqual(["- AGENTS.md", "- SUBSTRATE.md"]);

      const noneAdapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);
      await runPlanner(
        options(noneAdapter, { settings: { ...DEFAULT_SETTINGS, instructions: { workers: "none" } } })
      );
      expect(instructionSection(noneAdapter.spawnedRequests[0].prompt)).toBe("(none)");

      // Rule 3 uses a list passed by the caller as given.
      const listedAdapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);
      await runPlanner(
        options(listedAdapter, {
          settings: { ...DEFAULT_SETTINGS, instructions: { workers: "none" } },
          instructionFiles: ["SUBSTRATE.md", "AGENTS.md"],
        })
      );
      expect(instructionSection(listedAdapter.spawnedRequests[0].prompt)).toBe(
        "- SUBSTRATE.md\n- AGENTS.md"
      );
    });

    it("includes skills in the user prompt when provided, and renders (none) when omitted", async () => {
      const adapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);
      await runPlanner(
        options(adapter, {
          skillsList: [{ name: "data-transform", description: "Performs tabular transforms" }],
        })
      );

      const prompt = adapter.spawnedRequests[0].prompt;
      expect(prompt).toContain("data-transform");
      expect(prompt).toContain("Performs tabular transforms");

      const plainAdapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);
      await runPlanner(options(plainAdapter));
      expect(plainAdapter.spawnedRequests[0].prompt).toContain("## Skills\n(none)");
    });
  });

  describe("finish line, lint and format retries", () => {
    it("the finish line is the last non-empty line of final_text", () => {
      expect(finishLine("wrote the plan\n\n   PLAN READY   \n")).toBe("PLAN READY");
      expect(finishLine("answer\nNEEDS INPUT")).toBe("NEEDS INPUT");
      expect(finishLine("PLAN READY is written in the text")).not.toBe("PLAN READY");
    });

    it("a format error resumes the same session with the correction template", async () => {
      const adapter = adapterFor([
        { reply: "here is my draft", files: planFiles(runId) },
        { reply: "PLAN READY" },
      ]);

      const outcome = await runPlanner(options(adapter));
      expect(outcome.kind).toBe("plan_ready");

      expect(adapter.spawnedRequests.length).toBe(2);
      expect(adapter.spawnedRequests[1].session?.resume).toBe(adapter.spawnedRequests[0].session?.id);

      const correction = adapter.spawnedRequests[1].prompt;
      expect(correction).toContain("attempt 2 of 3");
      expect(correction).toContain("Problems");
      expect(correction).toContain("here is my draft");
    });

    it("linter errors become format diagnostics as [code] message", async () => {
      const adapter = adapterFor([
        {
          reply: "PLAN READY",
          files: {
            ...planFiles(runId),
            "tasks/T1.md": sampleValidTaskSpecMarkdown({
              frontmatter: { write: ["src/nothing-matches.ts"] },
            }),
          },
        },
        { reply: "PLAN READY", files: planFiles(runId) },
      ]);

      const outcome = await runPlanner(options(adapter));
      expect(outcome.kind).toBe("plan_ready");
      const correction = adapter.spawnedRequests[1].prompt;
      // L007 is no longer suppressed: a write pattern must match a file at base.
      expect(correction).toContain("[L007]");
      expect(correction).toContain("src/nothing-matches.ts");
    });

    it("L003, L019 and L027 are suppressed only because the plan files live in the run directory", async () => {
      const adapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);

      const outcome = await runPlanner(options(adapter));
      expect(outcome.kind).toBe("plan_ready");

      // The repo has no plan files, so the runDir suppression is what made the plan valid.
      expect(existsSync(join(repo.dir, "tasks", "T1.md"))).toBe(false);
      if (outcome.kind === "plan_ready") {
        expect(outcome.plan.specs.size).toBe(1);
      }
    });

    it("two format retries that both fail throw PlannerFailure('format')", async () => {
      const adapter = adapterFor([{ reply: "PLAN READY", files: { "manifest.yaml": "invalid: [unclosed" } }]);

      let caught: unknown;
      try {
        await runPlanner(options(adapter));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PlannerFailure);
      expect((caught as PlannerFailure).reason).toBe("format");
      expect(adapter.spawnedRequests.length).toBe(3);
    });

    it("a session failure throws PlannerFailure('session') without a retry", async () => {
      const adapter = adapterFor([
        { reply: "crashed", files: planFiles(runId), ok: false, exit_code: 1 },
      ]);

      let caught: unknown;
      try {
        await runPlanner(options(adapter));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PlannerFailure);
      expect((caught as PlannerFailure).reason).toBe("session");
      expect(adapter.spawnedRequests.length).toBe(1);
    });

    it("NEEDS INPUT requires QUESTIONS.md in the run directory, and returns needs_input", async () => {
      const adapter = adapterFor([
        { reply: "NEEDS INPUT", files: planFiles(runId) },
        { reply: "NEEDS INPUT", files: { "QUESTIONS.md": "Which cache layer?\n" } },
      ]);

      const outcome = await runPlanner(options(adapter));
      expect(outcome.kind).toBe("needs_input");
      if (outcome.kind !== "needs_input") return;
      expect(outcome.questionsPath).toBe(join(runDir, "QUESTIONS.md"));
    });
  });

  describe("failure messages for task.failed", () => {
    it("a session that exits non-zero carries the adapter's error event in its message", async () => {
      const adapter = createMockAdapter({
        nextSession: () => ({
          events: [
            { type: "session.started", session_id: "mock-session-fail" },
            {
              type: "error",
              kind: "protocol",
              message: "local provider needs a base URL: set backends.opencode.provider.base_url",
            },
            { type: "session.result", ok: false, final_text: "", exit_code: 1 },
          ],
          result: { ok: false, exit_code: 1, final_text: "" },
        }),
      });

      let caught: unknown;
      try {
        await runPlanner(options(adapter));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PlannerFailure);
      expect((caught as PlannerFailure).reason).toBe("session");
      const message = plannerFailureMessage(caught as PlannerFailure);
      expect(message).toMatch(/^Planner session failed with exit code 1: harness error: local provider needs a base URL/);
      expect(message).not.toContain("\n");
      expect(adapter.spawnedRequests.length).toBe(1);
    });

    it("a validation failure names its diagnostics on one line after the message", async () => {
      const adapter = adapterFor([{ reply: "PLAN READY", files: { "manifest.yaml": "invalid: [unclosed" } }]);

      let caught: unknown;
      try {
        await runPlanner(options(adapter));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PlannerFailure);
      const failure = caught as PlannerFailure;
      expect(failure.reason).toBe("format");
      expect(failure.diagnostics.length).toBeGreaterThan(0);
      const message = plannerFailureMessage(failure);
      expect(message.startsWith("Planner format retries exhausted after 3 attempts: ")).toBe(true);
      expect(message).not.toContain("\n");
      expect(message).toContain(failure.diagnostics[0].replace(/\s+/g, " ").trim());
    });
  });

  describe("contract typecheck and run branch commit", () => {
    it("typechecks the contract files in the run directory before committing", async () => {
      const collector = createEmitCollector(runId);
      const adapter = adapterFor([{ reply: "PLAN READY", files: planFiles(runId) }]);

      const outcome = await runPlanner(options(adapter, { onEvent: collector.onEvent }));
      expect(outcome.kind).toBe("plan_ready");
      if (outcome.kind !== "plan_ready") return;

      const commitSha = outcome.commitSha;
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);

      const branch = `substrate/runs/${runId}`;
      expect(repo.git(["rev-parse", "--verify", branch])).toBe(commitSha);

      // The committed tree holds the contract stub from the run directory.
      const tree = repo.git(["show", `${commitSha}:contracts/types.ts`]);
      expect(tree).toContain("runFeature");

      // Usage is recorded per attempt with role planner.
      const usageEvents = collector.byType("usage.recorded");
      expect(usageEvents.length).toBe(1);
      expect((usageEvents[0]?.data as { role?: string }).role).toBe("planner");
    });

    it("a failing contract typecheck is a format error and creates no run branch", async () => {
      const adapter = adapterFor([
        {
          reply: "PLAN READY",
          files: {
            "manifest.yaml": sampleValidManifestYaml(runId, {
              contracts: {
                files: ["contracts/types.ts"],
                typecheck: [{ run: "exit 1", timeout_s: 10 }],
              },
            }),
            "tasks/T1.md": sampleValidTaskSpecMarkdown(),
            "contracts/types.ts": sampleValidContractStub(),
          },
        },
      ]);

      let caught: unknown;
      try {
        await runPlanner(
          options(adapter, {
            settings: {
              ...DEFAULT_SETTINGS,
              budgets: { ...DEFAULT_SETTINGS.budgets, planner_format_retries: 1 },
            },
          })
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PlannerFailure);
      expect((caught as PlannerFailure).reason).toBe("format");
      expect(adapter.spawnedRequests.length).toBe(2);

      // Invariant: a plan that failed the typecheck is not committed.
      expect(() => repo.git(["rev-parse", "--verify", `substrate/runs/${runId}`])).toThrow();
    });

    it("commitContractStubs passes the ref value it read as the expected old value", async () => {
      mkdirSync(join(runDir, "contracts"), { recursive: true });
      writeFileSync(join(runDir, "contracts", "api.ts"), "export interface Api { id: string; }\n", "utf8");

      const contracts = { files: ["contracts/api.ts"], typecheck: [{ run: "echo ok", timeout_s: 10 }] };
      const branch = `substrate/runs/${runId}`;
      const baseSha = repo.git(["rev-parse", "main"]);

      // The ref does not exist yet, so the guard is the all-zero object id.
      const first = await commitContractStubs(repo.dir, runId, "main", contracts, runDir);
      expect(first).toMatch(/^[0-9a-f]{40}$/);
      expect(repo.git(["rev-parse", "--verify", branch])).toBe(first);
      expect(repo.git(["rev-parse", `${first}^1`])).toBe(baseSha);

      // A ref created before the read is the value the guard compares against, so a
      // commit built from a value read earlier cannot overwrite a ref that moved.
      writeFileSync(join(runDir, "contracts", "api.ts"), "export interface Api { id: number; }\n", "utf8");
      const second = await commitContractStubs(repo.dir, runId, "main", contracts, runDir);
      expect(repo.git(["rev-parse", "--verify", branch])).toBe(second);

      const plannerRead = first;
      const tree = repo.git(["write-tree"]);
      const plannerCommit = repo.git([
        "commit-tree",
        tree,
        "-p",
        baseSha,
        "-m",
        `feat(contracts): commit contract stubs for run ${runId}`,
      ]);

      let rejected = false;
      try {
        repo.git(["update-ref", `refs/heads/${branch}`, plannerCommit, plannerRead]);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(repo.git(["rev-parse", "--verify", branch])).toBe(second);
    });
  });
});
