import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Contracts from "../../../src/contracts/index.js";
import { createRunId, nowIsoTimestamp } from "../../../src/util/index.js";
import { reduce, type EngineState } from "../../../src/engine/reducer.js";
import { hasPlanSyncChanges, planSync } from "../../../src/engine/plan-sync.js";
import { taskExceptionData } from "../../../src/engine/effects.js";
import { sampleManifestYaml, sampleTaskSpecMarkdown } from "../spec/fixtures.js";

// 2026-10-23 (owner, b): the manifest and the live task state agree. These tests write a run directory the way a
// replan does and check what the engine registers, and that the reducer applies only what live state allows.

let runDir: string;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-"));
  fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

function writePlan(tasks: Array<{ id: string; depends_on?: string[]; write?: string[] }>): void {
  const entries = tasks.map((t) => ({ id: t.id, spec: `tasks/${t.id}.md` }));
  fs.writeFileSync(path.join(runDir, "manifest.yaml"), sampleManifestYaml({ tasks: entries }), "utf8");
  for (const t of tasks) {
    fs.writeFileSync(
      path.join(runDir, "tasks", `${t.id}.md`),
      sampleTaskSpecMarkdown({
        frontmatter: { id: t.id, title: `Task ${t.id}`, depends_on: t.depends_on ?? [], write: t.write ?? [], create: [] },
      }),
      "utf8",
    );
  }
}

function stateWith(tasks: EngineState["tasks"]): EngineState {
  return {
    run_id: createRunId(),
    state: "EXECUTING",
    tasks,
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  };
}

function makeEvent(type: string, data: unknown, seq = 1): Contracts.EngineEvent {
  return Contracts.EngineEvent.parse({ v: 1, seq, ts: nowIsoTimestamp(), run_id: createRunId(), type, data });
}

describe("planSync: the manifest against the live state", () => {
  it("registers a task the manifest has and the state lacks, with its dependencies and write set", () => {
    writePlan([{ id: "T1" }, { id: "FIX", write: ["src/fix.ts"] }, { id: "API1B", write: ["src/api.ts"] }, { id: "SUBAG", depends_on: ["FIX", "API1B"] }]);
    const sync = planSync(runDir, stateWith({ T1: { id: "T1", state: "MERGED", generation: 1, attempt: 1 } }));

    expect(sync.added).toEqual(["API1B", "FIX", "SUBAG"]);
    const subag = sync.tasks.find((t) => t.id === "SUBAG");
    expect(subag?.depends_on).toEqual(["FIX", "API1B"]);
    expect(hasPlanSyncChanges(sync)).toBe(true);
  });

  it("reports a pending task whose dependencies changed, and leaves a started task alone", () => {
    writePlan([{ id: "A", write: ["src/a.ts"] }, { id: "B", depends_on: ["A"] }]);
    const sync = planSync(
      runDir,
      stateWith({
        A: { id: "A", state: "RUNNING", generation: 1, attempt: 1, write: ["src/a.ts"], depends_on: [] },
        B: { id: "B", state: "PENDING", generation: 1, attempt: 1, depends_on: [], write: [], create: [] },
      }),
    );
    expect(sync.changed).toEqual(["B"]);
    expect(sync.tasks).toEqual([{ id: "B", depends_on: ["A"], write: [], create: [] }]);
  });

  it("drops a dependency that names no task of the plan, and says so in a warning", () => {
    writePlan([{ id: "T1", depends_on: ["GHOST"] }]);
    const sync = planSync(runDir, stateWith({}));

    expect(sync.repaired_dependencies).toEqual([{ task: "T1", dependency: "GHOST" }]);
    expect(sync.warnings.join(" ")).toContain("GHOST");
    expect(sync.tasks.find((t) => t.id === "T1")?.depends_on).toEqual([]);
  });

  it("abandons a pending task the manifest no longer names, and keeps a merged one", () => {
    writePlan([{ id: "T1" }]);
    const sync = planSync(
      runDir,
      stateWith({
        T1: { id: "T1", state: "PENDING", generation: 1, attempt: 1 },
        OLD: { id: "OLD", state: "PENDING", generation: 1, attempt: 1 },
        DONE: { id: "DONE", state: "MERGED", generation: 1, attempt: 1 },
      }),
    );
    expect(sync.dropped).toEqual(["OLD"]);
  });

  it("reports nothing when the state already matches the manifest, and nothing without a manifest", () => {
    writePlan([{ id: "T1" }]);
    const matched = planSync(runDir, stateWith({ T1: { id: "T1", state: "PENDING", generation: 1, attempt: 1, depends_on: [], write: [], create: [] } }));
    expect(hasPlanSyncChanges(matched)).toBe(false);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-none-"));
    try {
      expect(hasPlanSyncChanges(planSync(empty, stateWith({})))).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("plan.synced in the reducer: the live state decides", () => {
  const base = stateWith({
    RUN: { id: "RUN", state: "RUNNING", generation: 1, attempt: 1, depends_on: [] },
    PEND: { id: "PEND", state: "PENDING", generation: 1, attempt: 1, depends_on: [] },
    REPL: { id: "REPL", state: "REPLANNING", generation: 2, attempt: 1, depends_on: [] },
    OLD: { id: "OLD", state: "PENDING", generation: 1, attempt: 1, depends_on: [] },
  });

  it("registers an added task and updates a pending task's dependencies", () => {
    const next = reduce(base, makeEvent("plan.synced", {
      added: ["NEW"],
      changed: ["PEND"],
      dropped: [],
      tasks: [
        { id: "NEW", depends_on: [], write: ["src/n.ts"], create: [] },
        { id: "PEND", depends_on: ["RUN"], write: [], create: [] },
      ],
      repaired_dependencies: [],
      warnings: [],
    }));
    expect(next.tasks.NEW).toMatchObject({ state: "PENDING", write: ["src/n.ts"] });
    expect(next.tasks.PEND).toMatchObject({ state: "PENDING", depends_on: ["RUN"] });
  });

  it("never changes a task that has started", () => {
    const next = reduce(base, makeEvent("plan.synced", {
      added: [],
      changed: ["RUN"],
      dropped: [],
      tasks: [{ id: "RUN", depends_on: ["PEND"], write: [], create: [] }],
      repaired_dependencies: [],
      warnings: [],
    }));
    expect(next.tasks.RUN).toMatchObject({ state: "RUNNING", depends_on: [] });
  });

  it("gives the replanned task its new sets and keeps its replan state", () => {
    const next = reduce(base, makeEvent("plan.synced", {
      added: [],
      changed: ["REPL"],
      dropped: [],
      tasks: [{ id: "REPL", depends_on: ["PEND"], write: ["src/r.ts"], create: [] }],
      repaired_dependencies: [],
      warnings: [],
      replan_task_id: "REPL",
    }));
    expect(next.tasks.REPL).toMatchObject({ state: "REPLANNING", depends_on: ["PEND"], write: ["src/r.ts"] });
  });

  it("abandons a pending task that was dropped, and never a running one", () => {
    const next = reduce(base, makeEvent("plan.synced", {
      added: [],
      changed: [],
      dropped: ["OLD", "RUN"],
      tasks: [],
      repaired_dependencies: [],
      warnings: [],
    }));
    expect(next.tasks.OLD).toMatchObject({ state: "ABANDONED", dropped: true });
    expect(next.tasks.RUN.state).toBe("RUNNING");
  });
});

describe("run.amended: a changed task the state lacks is registered, not dropped", () => {
  it("adds the task in the state when the amendment changes an id the state does not have", () => {
    const next = reduce(stateWith({}), makeEvent("run.amended", {
      chat_id: "c1",
      outcome: "applied",
      applied_at: "live",
      added: [],
      changed: ["FIX"],
      dropped: [],
      kept_started: [],
      warning_count: 0,
      tasks: [{ id: "FIX", depends_on: [], write: ["src/fix.ts"], create: [] }],
    }));
    expect(next.tasks.FIX).toMatchObject({ state: "PENDING", write: ["src/fix.ts"] });
  });
});

describe("taskExceptionData: an exception inside one task is that task's failure", () => {
  it("records a non-replannable failure for a worker or replan action, with the error text", () => {
    const data = taskExceptionData({ type: "worker", taskId: "T1" }, new Error("boom in worker"));
    expect(data).toMatchObject({ task_id: "T1", failure_class: "worker_crashed", can_replan: false });
    expect(data?.detail).toContain("boom in worker");

    const replan = taskExceptionData({ type: "replan", taskId: "T2" }, "string failure");
    expect(replan).toMatchObject({ task_id: "T2", can_replan: false });
    expect(replan?.detail).toContain("string failure");
  });

  it("does not claim exceptions from actions that work on no single task", () => {
    expect(taskExceptionData({ type: "setup" }, new Error("x"))).toBeUndefined();
    expect(taskExceptionData({ type: "integration" }, new Error("x"))).toBeUndefined();
    expect(taskExceptionData({ type: "worker", taskId: "SOLO" }, new Error("x"))).toBeUndefined();
  });

  it("makes the task BLOCKED in the reducer, so its dependents can be skipped", () => {
    const data = taskExceptionData({ type: "worker", taskId: "T1" }, new Error("boom"));
    const state = stateWith({ T1: { id: "T1", state: "RUNNING", generation: 1, attempt: 1 } });
    const next = reduce(state, makeEvent("task.failed", data));
    expect(next.tasks.T1.state).toBe("BLOCKED");
  });
});
