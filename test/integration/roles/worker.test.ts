import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { createTestRepo, type TestRepo } from "../git/test-repo.js";
import {
  createMockAdapter,
  sampleValidTaskSpecFrontmatter,
  sampleValidTaskSpecMarkdown,
} from "./fixtures.js";
import type { WorkerEmit } from "../../../src/roles/worker.js";

export interface WorkerRunOptions {
  runId: Contracts.RunId;
  taskId: Contracts.TaskId;
  spec: Contracts.TaskSpecFrontmatter;
  specContent: string;
  specAbsPath: string;
  generation: number;
  repoRoot: string;
  settings: Contracts.Settings;
  adapter: Contracts.HarnessAdapter;
  baseRef: string;
  rawDir: string;
  setupCommands?: Contracts.Command[];
  /** Events go out through the action's typed emit (R3.3). */
  onEvent?: WorkerEmit;
}

let runWorker: (opts: WorkerRunOptions) => Promise<Contracts.WorkerReport>;

beforeAll(async () => {
  const mod = (await import("../../../src/roles/worker.js" as any)) as any;
  runWorker = mod.runWorker;
});

function makeRunId(): Contracts.RunId {
  return "r_234567ABCDEF";
}

/** Collector for the worker's emit callback, which takes (type, data). */
function createEmitCollector(runId: string): {
  events: Array<{ type: string; data: unknown }>;
  onEvent: WorkerEmit;
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
      } as Contracts.EngineEvent;
    },
    byType(type: string) {
      return events.filter((e) => e.type === type);
    },
    first(type: string) {
      return events.find((e) => e.type === type);
    },
  };
}

describe("Worker Runner (src/roles/worker.ts)", () => {
  let repo: TestRepo;
  let runDir: string;
  let specPath: string;
  let specMarkdown: string;

  beforeEach(() => {
    repo = createTestRepo("substrate-worker-test-");
    runDir = mkdtempSync(join(tmpdir(), "substrate-worker-rundir-"));

    // Prepare a base file and a protected file in the repo
    repo.commitFile("contracts/types.ts", "export interface Model { id: string; }\n");
    repo.commitFile("src/base.ts", "export const base = 42;\n");

    specMarkdown = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        class: "feature",
        read: ["contracts/types.ts"],
        write: ["src/feature.ts"],
        create: ["test/feature.test.ts"],
        protected: ["contracts/types.ts"],
        verify: [{ run: "echo verify passed", timeout_s: 30 }],
      },
    });

    specPath = join(runDir, "T1.md");
    writeFileSync(specPath, specMarkdown, "utf8");
  });

  afterEach(() => {
    repo.cleanup();
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  describe("worktree setup and isolated worker session spawning", () => {
    it("provisions worktree, materializes spec, spawns worker session with restricted permissions and passes on valid change", async () => {
      const runId = makeRunId();
      const collector = createEmitCollector(runId);
      const spec = sampleValidTaskSpecFrontmatter({
        id: "T1",
        write: ["src/feature.ts"],
        create: ["test/feature.test.ts"],
        protected: ["contracts/types.ts"],
        verify: [{ run: "echo verify passed", timeout_s: 30 }],
      });

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          // Simulate worker creating allowed files
          mkdirSync(join(req.cwd, "src"), { recursive: true });
          mkdirSync(join(req.cwd, "test"), { recursive: true });
          writeFileSync(join(req.cwd, "src", "feature.ts"), "export const feat = 1;\n", "utf8");
          writeFileSync(join(req.cwd, "test", "feature.test.ts"), "console.log('test');\n", "utf8");
        },
      });

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: DEFAULT_SETTINGS,
        adapter,
        baseRef: "main",
        rawDir: runDir,
        onEvent: collector.onEvent,
      });

      // Assert report
      expect(report.status).toBe("passed");
      expect(report.task_id).toBe("T1");
      expect(report.generation).toBe(1);
      expect(report.attempt).toBe(1);
      expect(report.files_changed).toEqual(expect.arrayContaining(["src/feature.ts", "test/feature.test.ts"]));

      // Invariants: worker permissions strictly deny git commit and subagents
      const req = adapter.spawnedRequests[0];
      expect(req.permission.deny).toContain("git commit");
      expect(req.permission.deny).toContain("git push");
      expect(req.permission.deny).toContain("git checkout");
      expect(req.permission.deny).toContain("git reset");

      // Verify lifecycle events emitted
      expect(collector.first("task.worktree.created")).toBeDefined();
      expect(collector.first("task.session.started")).toBeDefined();
      expect(collector.first("task.session.ended")).toBeDefined();
      expect(collector.first("task.scope.checked")).toBeDefined();
      expect(collector.first("task.verify.started")).toBeDefined();
      expect(collector.first("task.verify.finished")).toBeDefined();
      expect(collector.first("task.passed")).toBeDefined();

      // Invariant: Git commit was authored on the task branch by the engine
      const taskBranch = `substrate/tasks/${runId}/T1-g1`;
      const log = repo.git(["log", "-n", "1", "--format=%an <%ae>", taskBranch]);
      expect(log).toContain("substrate-engine");
    });

    it("executes setup commands in worktree; a failing setup is a warning and the worker still runs (R13.1)", async () => {
      const runId = makeRunId();
      const collector = createEmitCollector(runId);
      const spec = sampleValidTaskSpecFrontmatter({ id: "T1" });

      const adapter = createMockAdapter();

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: DEFAULT_SETTINGS,
        adapter,
        baseRef: "main",
        rawDir: runDir,
        setupCommands: [{ run: "exit 1", timeout_s: 10 }],
        onEvent: collector.onEvent,
      });

      // The setup failure is a warning: no task.failed, the worker spawns with the failure in its prompt.
      expect(collector.first("task.failed")).toBeUndefined();
      expect(collector.first("task.setup.failed")).toBeDefined();
      expect(report.failure_class).not.toBe("worker_crashed");
      expect(adapter.spawnedRequests.length).toBe(1);
      expect(adapter.spawnedRequests[0]?.prompt).toContain("Setup failed before you started");
    });
  });

  describe("scope checking and protected file invariants", () => {
    it("detects modification of protected files, skips L0 heal, and fails immediately with protected_modified", async () => {
      const runId = makeRunId();
      const collector = createEmitCollector(runId);
      const spec = sampleValidTaskSpecFrontmatter({
        id: "T1",
        protected: ["contracts/types.ts"],
        write: ["src/feature.ts"],
      });

      let attempts = 0;
      const adapter = createMockAdapter({
        onSpawn: (req) => {
          attempts++;
          // Worker modifies protected contract file!
          writeFileSync(
            join(req.cwd, "contracts", "types.ts"),
            "// Tampered contracts\n",
            "utf8",
          );
        },
      });

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: DEFAULT_SETTINGS,
        adapter,
        baseRef: "main",
        rawDir: runDir,
        onEvent: collector.onEvent,
      });

      expect(report.status).toBe("failed");
      expect(report.failure_class).toBe("protected_modified");
      // Protected violation skips healing: attempt must remain 1
      expect(attempts).toBe(1);
      expect(collector.first("task.healing")).toBeUndefined();
      expect(collector.first("task.failed")).toBeDefined();
    });

    it("fails task immediately with scope_violation when on_scope_violation is 'fail'", async () => {
      const runId = makeRunId();
      const collector = createEmitCollector(runId);
      const spec = sampleValidTaskSpecFrontmatter({
        id: "T1",
        write: ["src/feature.ts"],
      });

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          // Worker writes out-of-scope file
          writeFileSync(join(req.cwd, "unexpected.txt"), "sneaky file\n", "utf8");
        },
      });

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: {
          ...DEFAULT_SETTINGS,
          git: {
            ...DEFAULT_SETTINGS.git,
            on_scope_violation: "fail",
          },
        },
        adapter,
        baseRef: "main",
        rawDir: runDir,
        onEvent: collector.onEvent,
      });

      expect(report.status).toBe("failed");
      expect(report.failure_class).toBe("scope_violation");
      expect(collector.first("task.failed")).toBeDefined();
    });

    it("reverts out-of-scope files cleanly when on_scope_violation is 'revert' and proceeds to verify", async () => {
      const runId = makeRunId();
      const collector = createEmitCollector(runId);
      const spec = sampleValidTaskSpecFrontmatter({
        id: "T1",
        write: ["src/feature.ts"],
        verify: [{ run: "echo verify passed", timeout_s: 30 }],
      });

      let worktreeDir = "";
      const adapter = createMockAdapter({
        onSpawn: (req) => {
          worktreeDir = req.cwd;
          // Valid write
          writeFileSync(join(req.cwd, "src", "feature.ts"), "export const a = 1;\n", "utf8");
          // Out-of-scope write
          writeFileSync(join(req.cwd, "stray.txt"), "out of scope\n", "utf8");
        },
      });

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: {
          ...DEFAULT_SETTINGS,
          git: {
            ...DEFAULT_SETTINGS.git,
            on_scope_violation: "revert",
          },
        },
        adapter,
        baseRef: "main",
        rawDir: runDir,
        onEvent: collector.onEvent,
      });

      expect(report.status).toBe("passed");
      // Out-of-scope file was reverted/removed
      expect(existsSync(join(worktreeDir, "stray.txt"))).toBe(false);
      // Valid file committed
      expect(report.files_changed).toContain("src/feature.ts");
    });
  });

  describe("acceptance verification and engine-driven L0 healing", () => {
    it("executes L0 healing resume when first verify fails, and passes task if attempt 2 succeeds", async () => {
      const runId = makeRunId();
      const collector = createEmitCollector(runId);
      const spec = sampleValidTaskSpecFrontmatter({
        id: "T1",
        write: ["src/feature.ts"],
        verify: [{ run: "test -f src/feature.ts", timeout_s: 30 }],
      });

      let attemptCount = 0;
      let resumeSessionId: string | undefined;

      const adapter = createMockAdapter({
        onSpawn: (req) => {
          attemptCount++;
          if (attemptCount === 1) {
            // First attempt does not write file, so verify fails
          } else {
            // Second attempt (heal resume) writes the file
            resumeSessionId = req.session?.resume;
            mkdirSync(join(req.cwd, "src"), { recursive: true });
            writeFileSync(join(req.cwd, "src", "feature.ts"), "export const fixed = true;\n", "utf8");
          }
        },
      });

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: DEFAULT_SETTINGS,
        adapter,
        baseRef: "main",
        rawDir: runDir,
        onEvent: collector.onEvent,
      });

      expect(attemptCount).toBe(2);
      expect(resumeSessionId).toBeDefined();
      expect(collector.first("task.healing")).toBeDefined();
      expect(collector.first("task.passed")).toBeDefined();
      expect(report.status).toBe("passed");
      expect(report.attempt).toBe(2);
    });

    it("fails task after L0 heal if attempt 2 also fails verification (healing cap = 1)", async () => {
      const runId = makeRunId();
      const collector = createEmitCollector(runId);
      const spec = sampleValidTaskSpecFrontmatter({
        id: "T1",
        verify: [{ run: "exit 1", timeout_s: 10 }],
      });

      let attemptCount = 0;
      const adapter = createMockAdapter({
        onSpawn: () => {
          attemptCount++;
        },
      });

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: DEFAULT_SETTINGS,
        adapter,
        baseRef: "main",
        rawDir: runDir,
        onEvent: collector.onEvent,
      });

      // Attempt 1 fails -> heal Attempt 2 fails -> done (no attempt 3)
      expect(attemptCount).toBe(2);
      expect(collector.first("task.healing")).toBeDefined();
      expect(collector.first("task.failed")).toBeDefined();
      expect(report.status).toBe("failed");
      expect(report.failure_class).toBe("verify_failed");
      expect(report.attempt).toBe(2);
    });

    it("captures worker session crashes and timeouts as appropriate failure classes", async () => {
      const runId = makeRunId();
      const spec = sampleValidTaskSpecFrontmatter({ id: "T1" });

      const crashAdapter = createMockAdapter({
        sessionConfigs: [
          {
            result: { ok: false, exit_code: 137, killed_for: "timeout", final_text: "Timed out" },
          },
        ],
      });

      const report = await runWorker({
        runId,
        taskId: "T1",
        spec,
        specContent: specMarkdown,
        specAbsPath: specPath,
        generation: 1,
        repoRoot: repo.dir,
        settings: DEFAULT_SETTINGS,
        adapter: crashAdapter,
        baseRef: "main",
        rawDir: runDir,
      });

      expect(report.status).toBe("failed");
      expect(report.failure_class).toBe("timeout");
    });
  });
});
