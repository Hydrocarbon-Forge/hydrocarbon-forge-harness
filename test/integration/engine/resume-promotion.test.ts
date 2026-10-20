import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import type { EngineEvent, RunId, RunSummary } from "../../../src/contracts/index.js";
import { createEngine } from "../../../src/engine/engine.js";
import { createRunId } from "../../../src/util/index.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
  readEventLog,
  type ScenarioEnv,
} from "../scenarios/helpers.js";
import { sampleValidManifest, sampleValidTaskSpecMarkdown } from "../roles/fixtures.js";

// A two-task chain: B depends on A. Resuming a log cut after setup.done leaves both
// tasks PENDING (no task.ready was written), and a cut after task.merged leaves B
// PENDING with its dependency already merged. Both must continue, not stall.

const PLANNER_CALL = (files: Record<string, string>) => ({
  plan: { files },
  reply: "wrote the plan for the resume case\nPLAN READY",
});

const WORKER_A = {
  reply: "Worker passed verify",
  edits: { "src/a.ts": "// a\n" },
};

const WORKER_B = {
  reply: "Worker passed verify",
  edits: { "src/b.ts": "// b\n" },
};

function chainPlanFiles(): Record<string, string> {
  const manifest = {
    ...sampleValidManifest(),
    tasks: [
      { id: "A", spec: "tasks/A.md" },
      { id: "B", spec: "tasks/B.md" },
    ],
    integration_verify: [{ run: "echo integration verify pass", timeout_s: 30 }],
  };
  const specA = sampleValidTaskSpecMarkdown({
    frontmatter: {
      id: "A",
      title: "Task A",
      depends_on: [],
      write: ["src/a.ts"],
      create: [],
      verify: [{ run: "echo verify A", timeout_s: 30 }],
    },
  });
  const specB = sampleValidTaskSpecMarkdown({
    frontmatter: {
      id: "B",
      title: "Task B",
      depends_on: ["A"],
      write: ["src/b.ts"],
      create: [],
      verify: [{ run: "echo verify B", timeout_s: 30 }],
    },
  });
  return {
    "manifest.yaml": YAML.stringify(manifest),
    "tasks/A.md": specA,
    "tasks/B.md": specB,
    "contracts/types.ts": "export {};\n",
  };
}

function countOf(events: EngineEvent[], type: string, taskId: string): number {
  return events.filter((e) => e.type === type && (e.data as any)?.task_id === taskId).length;
}

describe("engine resume promotes PENDING tasks from a replayed log", () => {
  let env: ScenarioEnv;

  beforeEach(async () => {
    env = await setupScenarioEnv("resume-promotion");
    env.testRepo.commitFile("src/a.ts", "// existing file declared as write\n");
    env.testRepo.commitFile("src/b.ts", "// existing file declared as write\n");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // Runs the chain to completion once, cuts the event log so that it ends with the
  // first event of `type`, then resumes with `resumeCalls` as the worker replies.
  async function resumeFromCut(
    type: string,
    resumeCalls: unknown[]
  ): Promise<{ summary: RunSummary; events: EngineEvent[]; runId: RunId }> {
    const full = fakeClaudeAdapter([PLANNER_CALL(chainPlanFiles()), WORKER_A, WORKER_B]);
    let runId: RunId;
    try {
      const first = await createEngine({ adapter: full.adapter }).run({
        cwd: env.repoRoot,
        prompt: "Resume promotion case",
        mode: "plan",
        permission_mode: "bypassPermissions",
      });
      expect(first.exit_code).toBe(0);
      runId = first.run_id;
    } finally {
      full.cleanup();
    }

    const eventsPath = join(env.runDir, runId, "events.jsonl");
    const all = readEventLog(env.runDir, runId);
    const index = all.findIndex((e) => e.type === type);
    expect(index).toBeGreaterThanOrEqual(0);
    const kept = all.slice(0, index + 1);
    writeFileSync(eventsPath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    expect(existsSync(eventsPath)).toBe(true);

    const resume = fakeClaudeAdapter(resumeCalls);
    let summary: RunSummary;
    try {
      summary = await createEngine({ adapter: resume.adapter }).resume(runId, {
        cwd: env.repoRoot,
        permission_mode: "bypassPermissions",
      });
    } finally {
      resume.cleanup();
    }
    return { summary, events: readEventLog(env.runDir, runId), runId };
  }

  it(
    "continues a run cut after setup.done, releasing the first batch once",
    async () => {
      const { summary, events } = await resumeFromCut("setup.done", [WORKER_A, WORKER_B]);

      expect(summary.status).toBe("finished");
      expect(summary.exit_code).toBe(0);
      const finished = events.filter((e) => e.type === "run.finished");
      expect(finished[finished.length - 1].data).not.toHaveProperty("reason", "stalled");

      expect(countOf(events, "task.ready", "A")).toBe(1);
      expect(countOf(events, "task.ready", "B")).toBe(1);
      expect(countOf(events, "task.merged", "A")).toBe(1);
      expect(countOf(events, "task.merged", "B")).toBe(1);
    },
    120000
  );

  it(
    "continues a run cut after task.merged, promoting the dependent once",
    async () => {
      const { summary, events } = await resumeFromCut("task.merged", [WORKER_B]);

      expect(summary.status).toBe("finished");
      expect(summary.exit_code).toBe(0);
      const finished = events.filter((e) => e.type === "run.finished");
      expect(finished[finished.length - 1].data).not.toHaveProperty("reason", "stalled");

      expect(countOf(events, "task.ready", "A")).toBe(1);
      expect(countOf(events, "task.ready", "B")).toBe(1);
      expect(countOf(events, "task.merged", "A")).toBe(1);
      expect(countOf(events, "task.merged", "B")).toBe(1);
    },
    120000
  );
});
