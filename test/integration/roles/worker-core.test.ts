import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type {
  EngineEvent,
  HarnessAdapter,
  RunId,
  SessionHandle,
  SpawnRequest,
  TaskSpecFrontmatter,
  WorkerReport,
} from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import type { WorkerEmit, WorkerRunOptions } from "../../../src/roles/worker.js";
import { FakeAdapter } from "../../conformance/fake-adapter.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import {
  createMockAdapter,
  sampleValidTaskSpecFrontmatter,
  sampleValidTaskSpecMarkdown,
} from "./fixtures.js";

let runWorker: (opts: WorkerRunOptions) => Promise<WorkerReport>;

beforeAll(async () => {
  const mod = (await import("../../../src/roles/worker.js" as any)) as any;
  runWorker = mod.runWorker;
});

function makeRunId(): RunId {
  return "r_234567ABCDEF";
}

/** Collector for the worker's typed emit callback, which takes (type, data). */
function createEmitCollector(runId: string): {
  events: Array<{ type: string; data: unknown }>;
  onEvent: WorkerEmit;
  first: (type: string) => { type: string; data: unknown } | undefined;
} {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    events,
    onEvent<T extends string>(type: T, data: unknown) {
      events.push({ type, data });
      return { v: 1, seq: events.length, ts: new Date().toISOString(), run_id: runId, type, data } as EngineEvent;
    },
    first(type: string) {
      return events.find((e) => e.type === type);
    },
  };
}

function taskBranch(runId: string, taskId: string, generation: number): string {
  return `substrate/tasks/${runId}/${taskId}-g${generation}`;
}

describe("Worker core (R3.3)", () => {
  let repo: TestRepo;
  let runDir: string;
  let specMarkdown: string;

  beforeEach(() => {
    repo = createTestRepo("substrate-worker-core-");
    runDir = mkdtempSync(join(tmpdir(), "substrate-worker-core-run-"));

    repo.commitFile("contracts/types.ts", "export interface Model { id: string; }\n");
    repo.commitFile("src/base.ts", "export const base = 42;\n");

    specMarkdown = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        class: "feature",
        read: ["contracts/types.ts"],
        write: ["src/feature.ts"],
        create: [],
        protected: ["contracts/types.ts"],
        verify: [{ run: "echo verify passed", timeout_s: 30 }],
      },
    });
  });

  afterEach(() => {
    repo.cleanup();
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  function baseOptions(runId: string, spec: TaskSpecFrontmatter, onEvent: WorkerEmit) {
    return {
      runId,
      taskId: "T1",
      spec,
      specContent: specMarkdown,
      specAbsPath: join(runDir, "tasks", "T1.md"),
      generation: 1,
      repoRoot: repo.dir,
      settings: DEFAULT_SETTINGS,
      baseRef: "main",
      rawDir: runDir,
      session: { id: randomUUID() },
      onEvent,
    };
  }

  it("treats a worker that commits inside its session as a scope violation", async () => {
    const runId = makeRunId();
    const collector = createEmitCollector(runId);
    const spec = sampleValidTaskSpecFrontmatter({
      id: "T1",
      write: ["src/feature.ts"],
      protected: ["contracts/types.ts"],
      verify: [{ run: "echo verify passed", timeout_s: 30 }],
    });

    const base = new FakeAdapter();

    // The fake harness edits files in its cwd but cannot run git, so the test makes
    // the commit a committing worker would make while its session is in flight.
    const adapter: HarnessAdapter = {
      capabilities: base.capabilities,
      validateEnvironment: () => base.validateEnvironment(),
      spawn(req: SpawnRequest): SessionHandle {
        const handle = base.spawn(req);
        return {
          pid: handle.pid,
          events: (async function* () {
            writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feat = 1;\n", "utf8");
            for await (const event of handle.events) {
              yield event;
            }
            execFileSync("git", ["-C", req.cwd, "add", "-A"]);
            execFileSync("git", ["-C", req.cwd, "commit", "-m", "worker commit"]);
          })(),
          result: () => handle.result(),
          kill: (reason: "timeout" | "cancel") => handle.kill(reason),
        };
      },
    };

    const report = await runWorker({ ...baseOptions(runId, spec, collector.onEvent), adapter });

    expect(report.status).toBe("failed");
    expect(report.failure_class).toBe("scope_violation");

    const failed = collector.first("task.failed");
    expect(failed).toBeDefined();
    expect((failed?.data as any)?.failure_class).toBe("scope_violation");
    expect((failed?.data as any)?.detail).toBe("HEAD or branch changed");

    // Nothing was reverted and nothing was committed by the engine.
    expect(report.files_changed).toEqual([]);
    expect(collector.first("task.passed")).toBeUndefined();

    const branch = taskBranch(runId, "T1", 1);
    const messages = repo.git(["log", "--format=%s", branch]).split("\n");
    expect(messages[0]).toBe("worker commit");
    // The engine committed nothing on top of the base.
    expect(messages).not.toContain("feat(task): T1");
    // The worker commit is still the tip: the engine committed nothing after it.
    expect(repo.git(["log", "-1", "--format=%s", branch])).toBe("worker commit");
  });

  it("passes an empty diff with a passing verify, and commits nothing", async () => {
    const runId = makeRunId();
    const collector = createEmitCollector(runId);
    const spec = sampleValidTaskSpecFrontmatter({
      id: "T1",
      write: ["src/feature.ts"],
      protected: ["contracts/types.ts"],
      verify: [{ run: "echo verify passed", timeout_s: 30 }],
    });

    const adapter = createMockAdapter();

    const report = await runWorker({ ...baseOptions(runId, spec, collector.onEvent), adapter });

    expect(report.status).toBe("passed");
    expect(report.files_changed).toEqual([]);
    expect(collector.first("task.verify.finished")).toBeDefined();

    const branch = taskBranch(runId, "T1", 1);
    // No commit on the task branch: its tip is still the base.
    expect(repo.git(["rev-parse", branch])).toBe(repo.git(["rev-parse", "main"]));
  });

  it("returns the registered worktree for the same task generation instead of recreating it", async () => {
    const runId = makeRunId();
    const spec = sampleValidTaskSpecFrontmatter({
      id: "T1",
      write: ["src/feature.ts"],
      protected: ["contracts/types.ts"],
      verify: [{ run: "echo verify passed", timeout_s: 30 }],
    });

    const adapter = createMockAdapter({
      onSpawn: (req) => {
        writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feat = 1;\n", "utf8");
      },
    });

    const first = createEmitCollector(runId);
    const firstReport = await runWorker({ ...baseOptions(runId, spec, first.onEvent), adapter });
    expect(firstReport.status).toBe("passed");
    const worktreePath = join(repo.dir, ".substrate", "worktrees", runId, "T1-g1");
    expect((first.first("task.worktree.created")?.data as any)?.path).toBe(worktreePath);
    expect(existsSync(join(worktreePath, "src", "feature.ts"))).toBe(true);

    // The second attempt for the same generation gets the same worktree, with the
    // change the first attempt made still in it: it is never removed.
    const second = createEmitCollector(runId);
    const secondReport = await runWorker({
      ...baseOptions(runId, spec, second.onEvent),
      adapter,
      attempt: 2,
      session: { resume: firstReport.session_id },
    });

    expect((second.first("task.worktree.created")?.data as any)?.path).toBe(worktreePath);
    expect(readWorktreeFile(repo.dir, runId, "T1", 1, "src/feature.ts")).toBe("export const feat = 1;\n");
    expect(secondReport.status).toBe("passed");
  });

  it("errors when the task branch exists, rather than reusing it", async () => {
    const runId = makeRunId();
    const spec = sampleValidTaskSpecFrontmatter({
      id: "T1",
      write: ["src/feature.ts"],
      protected: ["contracts/types.ts"],
      verify: [{ run: "echo verify passed", timeout_s: 30 }],
    });

    const adapter = createMockAdapter();

    const collector = createEmitCollector(runId);
    const report = await runWorker({ ...baseOptions(runId, spec, collector.onEvent), adapter });
    expect(report.status).toBe("passed");

    const worktreePath = join(repo.dir, ".substrate", "worktrees", runId, "T1-g1");
    // The branch is still there, the worktree is not: an existing branch is an error.
    execFileSync("git", ["-C", repo.dir, "worktree", "remove", "--force", worktreePath]);
    expect(existsSync(worktreePath)).toBe(false);

    const second = createEmitCollector(runId);
    await expect(
      runWorker({ ...baseOptions(runId, spec, second.onEvent), adapter })
    ).rejects.toThrow(/already exists and is not reused/);
  });

  it("puts the run id in the worktree path", async () => {
    const runId = makeRunId();
    const spec = sampleValidTaskSpecFrontmatter({
      id: "T1",
      write: ["src/feature.ts"],
      protected: ["contracts/types.ts"],
      verify: [{ run: "echo verify passed", timeout_s: 30 }],
    });

    const adapter = createMockAdapter();
    const collector = createEmitCollector(runId);

    const report = await runWorker({ ...baseOptions(runId, spec, collector.onEvent), adapter });
    expect(report.status).toBe("passed");

    const path = (collector.first("task.worktree.created")?.data as any)?.path as string;
    expect(path).toContain(runId);
    expect(path).toContain("T1-g1");
    expect(repo.git(["branch", "--list", taskBranch(runId, "T1", 1)])).toContain(taskBranch(runId, "T1", 1));
  });
});

function readWorktreeFile(repoDir: string, runId: string, taskId: string, generation: number, rel: string): string {
  return readFileSync(join(repoDir, ".substrate", "worktrees", runId, `${taskId}-g${generation}`, rel), "utf8");
}
