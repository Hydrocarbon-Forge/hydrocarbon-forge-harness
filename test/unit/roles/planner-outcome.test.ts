import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { Settings } from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { createRunId } from "../../../src/util/index.js";
import { PlannerFailure, runPlanner, type PlannerEmit } from "../../../src/roles/planner.js";
import {
  createMockAdapter,
  sampleValidManifestYaml,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../../integration/roles/fixtures.js";
import { createTestRepo, type TestRepo } from "../../integration/git/test-repo.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What each planner attempt replies, and what it writes into the run directory. */
interface Attempt {
  reply: string;
  files?: Record<string, string>;
  remove?: string[];
  ok?: boolean;
  exit_code?: number;
}

/** The plan artifacts a planner session writes, as the prompt template requires. */
function planFiles(runId: string): Record<string, string> {
  return {
    "manifest.yaml": sampleValidManifestYaml(runId),
    "tasks/T1.md": sampleValidTaskSpecMarkdown(),
    "contracts/types.ts": sampleValidContractStub(),
  };
}

/** Collector for the planner's emit callback, which takes (type, data). */
function createEmitCollector(runId: string): {
  events: Array<{ type: string; data: unknown }>;
  onEvent: PlannerEmit;
  byType: (type: string) => Array<{ type: string; data: unknown }>;
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
  };
}

describe("Planner outcome: the finish line decides (R3.1)", () => {
  let repo: TestRepo;
  let parentDir: string;
  let runDir: string;
  let runId: string;

  beforeEach(() => {
    repo = createTestRepo("planner-outcome-");
    parentDir = mkdtempSync(join(tmpdir(), "planner-outcome-parent-"));
    runDir = mkdtempSync(join(parentDir, "run"));
    runId = createRunId();
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
    repo.cleanup();
  });

  function adapterFor(attempts: Attempt[]) {
    return createMockAdapter({
      nextSession: (req, index) => {
        const attempt = attempts[index];
        for (const [relPath, content] of Object.entries(attempt?.files ?? {})) {
          const full = join(req.cwd, relPath);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content, "utf8");
        }
        for (const relPath of attempt?.remove ?? []) {
          unlinkSync(join(req.cwd, relPath));
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
    adapter: ReturnType<typeof createMockAdapter>,
    onEvent?: PlannerEmit,
    settings: Settings = DEFAULT_SETTINGS
  ) {
    return {
      runId,
      repoRoot: repo.dir,
      runDir,
      request: "Build feature",
      settings,
      adapter,
      ...(onEvent ? { onEvent } : {}),
    };
  }

  it("reads the outcome from the last non-empty line, not from file content", async () => {
    const adapter = adapterFor([
      {
        reply: "wrote manifest.yaml\n\n   PLAN READY   \n\n",
        files: planFiles(runId),
      },
    ]);

    const outcome = await runPlanner(options(adapter));
    expect(outcome.kind).toBe("plan_ready");
    if (outcome.kind !== "plan_ready") return;

    expect(outcome.plan.manifest.run_id).toBe(runId);
    expect(outcome.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // The planner cannot know a session id before the first spawn, so it generates one.
    expect(adapter.spawnedRequests[0].session?.id).toMatch(UUID_REGEX);
    expect(outcome.sessionId).toBe(adapter.spawnedRequests[0].session?.id);
  });

  it("a finish line that only mentions PLAN READY is a format error, retried in the same session", async () => {
    const adapter = adapterFor([
      { reply: "I believe this plan is PLAN READY.", files: planFiles(runId) },
      { reply: "The plan is written.\nPLAN READY" },
    ]);

    const outcome = await runPlanner(options(adapter));
    expect(outcome.kind).toBe("plan_ready");
    expect(adapter.spawnedRequests.length).toBe(2);

    const firstSessionId = adapter.spawnedRequests[0].session?.id;
    expect(adapter.spawnedRequests[1].session?.resume).toBe(firstSessionId);

    const correction = adapter.spawnedRequests[1].prompt;
    expect(correction).toContain("attempt 2 of 3");
    expect(correction).toContain("Problems");
    expect(correction).toContain("I believe this plan is PLAN READY.");
  });

  it("QUESTIONS.md paired with PLAN READY is a format error", async () => {
    const adapter = adapterFor([
      { reply: "PLAN READY", files: { ...planFiles(runId), "QUESTIONS.md": "Which storage backend?\n" } },
      { reply: "PLAN READY", remove: ["QUESTIONS.md"] },
    ]);

    const outcome = await runPlanner(options(adapter));
    expect(outcome.kind).toBe("plan_ready");

    const correction = adapter.spawnedRequests[1].prompt;
    expect(correction).toContain("QUESTIONS.md");
    expect(correction).toContain("PLAN READY");
  });

  it("NEEDS INPUT without QUESTIONS.md is a format error; with it the plan pauses on questions", async () => {
    const collector = createEmitCollector(runId);
    const adapter = adapterFor([
      {
        reply: "I need to know the cache layer first.\nNEEDS INPUT",
        files: planFiles(runId),
      },
      {
        reply: "NEEDS INPUT",
        files: { "QUESTIONS.md": "Which cache layer?\n" },
      },
    ]);

    const outcome = await runPlanner(options(adapter, collector.onEvent));
    expect(outcome.kind).toBe("needs_input");
    if (outcome.kind !== "needs_input") return;

    expect(outcome.questionsPath).toBe(join(runDir, "QUESTIONS.md"));

    // A paused plan does not commit contract stubs, so no run branch is created.
    expect(() => repo.git(["rev-parse", "--verify", `substrate/runs/${runId}`])).toThrow();
  });

  it("fenced blocks are only the fallback, and a path that escapes runDir is a format error", async () => {
    const adapter = adapterFor([
      { reply: "```yaml:../escaped.yaml\nrun_id: x\n```\nPLAN READY" },
      {
        reply:
          "```yaml:manifest.yaml\n" +
          sampleValidManifestYaml(runId) +
          "\n```\n```markdown:tasks/T1.md\n" +
          sampleValidTaskSpecMarkdown() +
          "\n```\n```typescript:contracts/types.ts\n" +
          sampleValidContractStub() +
          "\n```\nPLAN READY",
      },
    ]);

    const outcome = await runPlanner(options(adapter));
    expect(outcome.kind).toBe("plan_ready");

    const correction = adapter.spawnedRequests[1].prompt;
    expect(correction).toContain("escaped.yaml");

    // Nothing was written outside the run directory.
    expect(existsSync(join(parentDir, "escaped.yaml"))).toBe(false);
    expect(existsSync(join(runDir, "manifest.yaml"))).toBe(true);
  });

  it("a failed session throws PlannerFailure('session') without a retry", async () => {
    // A session can write a valid plan and still fail; files do not decide the outcome.
    const adapter = adapterFor([
      { reply: "Process error", files: planFiles(runId), ok: false, exit_code: 1 },
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

  it("exhausted format retries throw PlannerFailure('format') with the diagnostics", async () => {
    const adapter = adapterFor([
      { reply: "PLAN READY", files: { "manifest.yaml": "invalid: [unclosed" } },
    ]);

    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      budgets: { ...DEFAULT_SETTINGS.budgets, planner_format_retries: 1 },
    };

    let caught: unknown;
    try {
      await runPlanner(options(adapter, undefined, settings));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PlannerFailure);
    expect((caught as PlannerFailure).reason).toBe("format");
    expect((caught as PlannerFailure).diagnostics.length).toBeGreaterThan(0);

    // Attempt 1 plus one retry, and the retry resumes the same session.
    expect(adapter.spawnedRequests.length).toBe(2);
    expect(adapter.spawnedRequests[1].session?.resume).toBe(
      adapter.spawnedRequests[0].session?.id
    );
  });

  it("records usage for every attempt with role planner", async () => {
    const collector = createEmitCollector(runId);
    const adapter = adapterFor([
      { reply: "PLAN READY", files: { "manifest.yaml": "invalid: [unclosed" } },
      { reply: "PLAN READY", files: planFiles(runId) },
    ]);

    const outcome = await runPlanner(options(adapter, collector.onEvent));
    expect(outcome.kind).toBe("plan_ready");

    const usageEvents = collector.byType("usage.recorded");
    expect(usageEvents.length).toBe(2);
    expect(usageEvents.every((e) => (e.data as { role?: string }).role === "planner")).toBe(true);
    if (outcome.kind === "plan_ready") {
      expect(outcome.usage.cost_usd).toBeCloseTo(0.002, 6);
    }
  });
});
