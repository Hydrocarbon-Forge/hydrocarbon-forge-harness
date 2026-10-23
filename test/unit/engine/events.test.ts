import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventV1, EVENT_TYPES, parseEngineEvent, type EventType } from "../../../src/contracts/events.js";
import { makeEmitter } from "../../../src/engine/emit.js";
import type { EffectContext } from "../../../src/engine/effects.js";
import type { EngineState } from "../../../src/engine/reducer.js";
import { FakeAdapter } from "../../conformance/fake-adapter.js";

const SAMPLE_RECORD = {
  backend: "claude" as const,
  model: "claude-haiku-5-5",
  input_tokens: 10,
  output_tokens: 5,
  cost_usd: 0.0001,
  cost_source: "reported" as const,
  at: "2026-01-01T00:00:00.000Z",
};

// One valid `data` payload per catalog member.
const SAMPLES: Record<EventType, Record<string, unknown>> = {
  "run.created": {},
  "run.routed": { mode: "solo" },
  "run.paused": { reason: "user_cancel" },
  "run.resumed": {},
  "run.reopened": { reason: "tasks", failed_tasks: ["T2"], skipped_tasks: ["T3"], kept_tasks: ["T1"] },
  "run.message": { message_id: 1, kind: "amendment", chat_id: "c1" },
  "run.amended": {
    chat_id: "c1",
    outcome: "applied",
    applied_at: "live",
    added: ["T4"],
    changed: [],
    dropped: [],
    kept_started: ["T1"],
    warning_count: 0,
    tasks: [{ id: "T4", depends_on: ["T1"], write: ["src/d.txt"], create: [] }],
  },
  "plan.synced": {
    added: ["FIX"],
    changed: [],
    dropped: [],
    tasks: [{ id: "FIX", depends_on: [], write: ["src/fix.ts"], create: [] }],
    repaired_dependencies: [{ task: "T2", dependency: "GHOST" }],
    warnings: ["task T2 depends on GHOST, which is not in the plan; the dependency is dropped"],
  },
  "run.finished": { exit_code: 0 },
  "run.budget.warning": { cost_usd: 0.8, max_usd: 1 },
  "run.budget.exceeded": {},
  "plan.started": {},
  "plan.produced": {},
  "plan.lint": {},
  "plan.approved": {},
  "plan.rejected": {},
  "plan.format_rejected": { attempt: 1, max_attempts: 3, errors: ["[L003] missing path"] },
  "plan.ready": {},
  "contracts.committed": {},
  "setup.done": {},
  "batch.started": {},
  "batch.merged": { batch: ["T1"], checkpoint_ref: "abc123" },
  "task.ready": { task_id: "T1" },
  "task.worktree.created": { task_id: "T1" },
  "task.session.started": { task_id: "T1", generation: 1, attempt: 1, session_id: "s-1" },
  "task.session.ended": { task_id: "T1" },
  "task.scope.checked": { task_id: "T1", generation: 1, attempt: 1, ok: true },
  "scope.checked": { task_id: "T1", generation: 1, attempt: 1, ok: true },
  "task.verify.started": { task_id: "T1", generation: 1, attempt: 1 },
  "task.verify.finished": { task_id: "T1", generation: 1, attempt: 1, passed: true },
  "task.healing": {
    task_id: "T1",
    generation: 1,
    attempt: 2,
    failures: "Command: echo fail\nExit code: 1\nStderr:\nboom",
  },
  "task.passed": { task_id: "T1" },
  "task.merged": { task_id: "T1" },
  "task.blocked": { task_id: "T1" },
  "task.skipped": { task_id: "T2", reason: "dependency_failed", failed: ["T1"], skipped: [] },
  "task.failed": { failure_class: "verify_failed" },
  "task.setup.failed": { task_id: "T1", generation: 1, attempt: 1, command: "npm ci", reason: "exit 1" },
  "task.replanned": { task_id: "T1", generation: 2 },
  "tasks.invalidated": { task_ids: ["T1"] },
  "replan.started": {},
  "replan.finished": { task_id: "T1", generation: 2 },
  "replan.l2": {},
  "integration.started": {},
  "integration.setup.started": { commands: 1 },
  "integration.setup.finished": { passed: true },
  "integration.skipped": { reason: "single_task" },
  "integration.could_not_run": { command: "npx tsc -p tsconfig.json", reason: "tsc is not installed" },
  "integration.finished": { passed: true },
  "integration.repair.started": { task_id: "REPAIR-1", attempt: 1, max: 2 },
  "integration.repair.finished": { task_id: "REPAIR-1", attempt: 1, passed: false, reason: "it deletes test file test/a.test.ts" },
  "integration.failed": {},
  "bisect.started": {},
  "bisect.culprit": { culprit_task_id: "T1" },
  "merge.conflict": { task_id: "T1", conflict_files: ["src/a.txt"] },
  "usage.recorded": { record: SAMPLE_RECORD, role: "worker" },
  "rate_limit.backoff": { task_id: "T1", concurrency: 2 },
};

const CATALOG_TYPES = new Set(EVENT_TYPES);

function baseEvent(type: EventType, data: Record<string, unknown>) {
  return {
    v: 1 as const,
    seq: 1,
    ts: "2026-01-01T00:00:00.000Z",
    run_id: "r_TESTABCDEFGH",
    type,
    data,
  };
}

function makeTestEmitter() {
  // A fresh directory per call: the store now validates sequence numbering
  // against what is already in the log, so a shared directory would carry state
  // from the previous call.
  const base = mkdtempSync(join(tmpdir(), "sub-events-"));
  const ctx = {
    runId: "r_TESTABCDEFGH",
    repoRoot: base,
    runDir: join(base, "run"),
    settings: {},
    adapter: new FakeAdapter(),
  } as unknown as EffectContext;
  const state = {
    run_id: "r_TESTABCDEFGH",
    state: "CREATED",
    tasks: {},
    usage: { total_usd: 0, by_role: {} },
    checkpoints: [],
  } as EngineState;
  return makeEmitter(ctx, state);
}

describe("event catalog", () => {
  it("EVENT_TYPES and the union cover the same members", () => {
    const sampleTypes = Object.keys(SAMPLES);
    expect(sampleTypes.length).toBe(EVENT_TYPES.length);
    for (const type of EVENT_TYPES) {
      expect(SAMPLES[type]).toBeDefined();
    }
  });

  for (const type of EVENT_TYPES) {
    it(`parses a valid ${type} event`, () => {
      const parsed = parseEngineEvent(baseEvent(type, SAMPLES[type]));
      expect(parsed.type).toBe(type);
    });

    it(`rejects an invalid ${type} event`, () => {
      // Wrong envelope version must fail for every member.
      const bad = { ...baseEvent(type, SAMPLES[type]), v: 2 };
      expect(() => parseEngineEvent(bad)).toThrow(new RegExp(type));
    });
  }

  it("rejects an unknown event type", () => {
    const bad = baseEvent("not.an.event" as EventType, {});
    expect(() => parseEngineEvent(bad)).toThrow(/invalid event type/);
  });

  it("rejects a member whose data does not match its shape", () => {
    const bad = baseEvent("run.routed", { mode: "sideways" });
    expect(() => parseEngineEvent(bad)).toThrow(/run.routed/);
  });

  it("typed emit accepts a catalog member and pushes the event", () => {
    const { events, emit } = makeTestEmitter();
    const evt = emit("task.ready", { task_id: "T1" });
    expect(events).toHaveLength(1);
    expect(evt.type).toBe("task.ready");
    expect(evt.seq).toBe(1);
  });

  it("typed emit throws on an unknown type", () => {
    const { emit } = makeTestEmitter();
    expect(() =>
      (emit as (t: string, d: Record<string, unknown>) => unknown)(
        "not.an.event",
        {}
      )
    ).toThrow(/invalid event type/);
  });

  it("typed emit throws on malformed data and pushes nothing", () => {
    const { events, emit } = makeTestEmitter();
    expect(() =>
      emit("run.routed", { mode: "sideways" } as never)
    ).toThrow(/run.routed/);
    expect(events).toHaveLength(0);
  });

  it("every catalog member is a strict object", () => {
    const options = EngineEventV1.options;
    for (const member of options) {
      expect(member._def.unknownKeys).toBe("strict");
    }
    expect(options.length).toBe(CATALOG_TYPES.size);
  });
});
