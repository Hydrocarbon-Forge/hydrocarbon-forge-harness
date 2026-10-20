import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as Contracts from "../../../src/contracts/index.js";
import { EngineEventV1 } from "../../../src/contracts/events.js";

// Every Appendix A declaration must exist exactly once as a zod schema.
// The inferred type must be re-exported under the exact same name
// (value + type sharing one identifier). No renamed or added contract types.
const EXPECTED_DECLARATIONS = [
  "RunId",
  "TaskId",
  "SessionId",
  "BackendName",
  "Effort",
  "RoleName",
  "TaskClass",
  "PermissionMode",
  "PauseReason",
  "FailureClass",
  "Command",
  "Budget",
  "Manifest",
  "TaskSpecFrontmatter",
  "VerifyResult",
  "UsageRecord",
  "WorkerReport",
  "FailurePacket",
  "Diagnostic",
  "BackendEvent",
  "Capabilities",
  "SpawnRequest",
  "SessionResult",
  "SessionHandle",
  "EnvReport",
  // ModelInfo is not in Appendix A; it was added by R2.6 per owner decision
  // (2026-10-18), see docs/archive/2026-10-20-r-series/BLOCKED.md.
  "ModelInfo",
  // ProfileSlot and Profile are not in Appendix A either; they are the contracts R2.9's
  // Interface mandates, added by following the R2.6 decision above (see docs/archive/2026-10-20-r-series/BLOCKED.md),
  // and recorded as a Deviation in R2.9's PROGRESS.md Notes (docs/archive/2026-10-20-r-series/PROGRESS.md).
  "ProfileSlot",
  "Profile",
  "HarnessAdapter",
  "Settings",
  "Route",
  "PricingTable",
  "RunOptions",
  "RunSummary",
  "Engine",
  "EngineEvent",
  "ExecutionStrategy",
  "RoutingDecision",
  "UsageLedgerEntry",
] as const;

function schema(name: string): z.ZodTypeAny {
  const value = (Contracts as unknown as Record<string, unknown>)[name];
  expect(value, `contract schema ${name} must be exported`).toBeDefined();
  const candidate = value as { safeParse?: unknown; parse?: unknown };
  expect(typeof candidate.safeParse, `${name} must be a zod schema (safeParse)`).toBe("function");
  expect(typeof candidate.parse, `${name} must be a zod schema (parse)`).toBe("function");
  return value as z.ZodTypeAny;
}

function expectAccept(name: string, value: unknown) {
  const result = schema(name).safeParse(value);
  expect(result.success, `${name} should accept ${JSON.stringify(value)?.slice(0, 500)}`).toBe(true);
}

function expectReject(name: string, value: unknown) {
  const result = schema(name).safeParse(value);
  expect(
    result.success,
    `${name} should reject ${JSON.stringify(value)?.slice(0, 500)}`,
  ).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

const VALID_RUN_ID = "r_ABCDEFGHIJKL";
const VALID_TASK_ID = "T1-foo_bar";
const VALID_USAGE = {
  backend: "claude",
  model: "claude-sonnet-5-5",
  input_tokens: 10,
  output_tokens: 5,
  cost_usd: 0.001,
  cost_source: "reported",
  at: "2026-10-16T00:00:00.000Z",
};
const VALID_COMMAND = { run: "npm test", timeout_s: 60 };
const VALID_VERIFY = {
  cmd: "npm test",
  exit_code: 0,
  timed_out: false,
  duration_ms: 12,
  stdout_tail: "ok",
  stderr_tail: "",
  truncated: false,
};

describe("contract catalogue: every Appendix A name exists once as a zod schema", () => {
  it("exports exactly the Appendix A declarations (no renames, no extras)", () => {
    const exportedSchemaNames = Object.keys(Contracts).filter((key) => {
      const v = (Contracts as unknown as Record<string, unknown>)[key];
      return (
        !!v &&
        typeof (v as { safeParse?: unknown }).safeParse === "function" &&
        (EXPECTED_DECLARATIONS as readonly string[]).includes(key)
      );
    });
    for (const name of EXPECTED_DECLARATIONS) {
      expect(exportedSchemaNames).toContain(name);
    }
    // No added contract-type schemas beyond Appendix A.
    const extras = Object.keys(Contracts).filter((key) => {
      const v = (Contracts as unknown as Record<string, unknown>)[key];
      const looksLikeSchema =
        !!v && typeof (v as { safeParse?: unknown }).safeParse === "function";
      return looksLikeSchema && !(EXPECTED_DECLARATIONS as readonly string[]).includes(key);
    });
    expect(extras).toEqual([]);
  });

  it("re-exports inferred types under the exact same names (type-level)", () => {
    // These assignments only compile when `export type X = z.infer<typeof X>` exists
    // for each declaration alongside the schema value.
    const runId: Contracts.RunId = VALID_RUN_ID;
    const taskId: Contracts.TaskId = VALID_TASK_ID;
    const backend: Contracts.BackendName = "claude";
    const effort: Contracts.Effort = "medium";
    const role: Contracts.RoleName = "worker";
    const strategy: Contracts.ExecutionStrategy = "direct";
    expect([runId, taskId, backend, effort, role, strategy].length).toBe(6);
  });
});

describe("identifiers and enums", () => {
  it("RunId accepts r_ plus 12 base32 chars, rejects anything else", () => {
    expectAccept("RunId", VALID_RUN_ID);
    expectAccept("RunId", "r_222222222222");
    expectReject("RunId", "r_abcdef123456");
    expectReject("RunId", "r_ABC");
    expectReject("RunId", "r_ABCDEFGHIJKLM");
    expectReject("RunId", "x_ABCDEFGHIJKL");
    expectReject("RunId", "ABCDEFGHIJKL");
    expectReject("RunId", "");
    expectReject("RunId", 123);
    expectReject("RunId", null);
  });

  it("TaskId enforces the declared pattern", () => {
    expectAccept("TaskId", "A");
    expectAccept("TaskId", VALID_TASK_ID);
    expectAccept("TaskId", "Z" + "a0_-".repeat(7) + "aaa");
    expectReject("TaskId", "a-lower-start");
    expectReject("TaskId", "");
    expectReject("TaskId", "A" + "x".repeat(32));
    expectReject("TaskId", "A has space");
    expectReject("TaskId", "A.dot");
    expectReject("TaskId", "A/slash");
    expectReject("TaskId", 42);
  });

  it("SessionId is opaque string, rejects non-strings", () => {
    expectAccept("SessionId", "sess-abc-123");
    expectAccept("SessionId", "anything-opaque::1");
    expectReject("SessionId", 123);
    expectReject("SessionId", null);
  });

  it("BackendName enum", () => {
    for (const v of ["claude", "opencode", "agy", "fake"]) expectAccept("BackendName", v);
    expectReject("BackendName", "CLAUDE");
    expectReject("BackendName", "custom");
    expectReject("BackendName", "");
  });

  it("Effort enum", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max"]) expectAccept("Effort", v);
    expectReject("Effort", "Medium");
    expectReject("Effort", "ultra");
  });

  it("RoleName enum", () => {
    for (const v of ["planner", "worker", "test-writer", "reviewer"])
      expectAccept("RoleName", v);
    expectReject("RoleName", "governor");
    expectReject("RoleName", "Worker");
    expectReject("RoleName", "admin");
  });

  it("TaskClass accepts routing keys as strings, rejects non-strings", () => {
    expectAccept("TaskClass", "feature");
    expectAccept("TaskClass", "mechanical");
    expectReject("TaskClass", 123);
    expectReject("TaskClass", null);
  });

  it("PermissionMode enum", () => {
    for (const v of ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"])
      expectAccept("PermissionMode", v);
    expectReject("PermissionMode", "accept-edits");
    expectReject("PermissionMode", "readonly");
  });

  it("PauseReason enum covers all seven reasons", () => {
    for (const v of [
      "needs_approval",
      "permission_denied",
      "budget_exhausted",
      "rate_limited",
      "user_cancel",
      "needs_human",
      "backend_unavailable",
    ])
      expectAccept("PauseReason", v);
    expectReject("PauseReason", "paused");
    expectReject("PauseReason", "");
  });

  it("FailureClass enum covers all eleven classes", () => {
    for (const v of [
      "verify_failed",
      "scope_violation",
      "protected_modified",
      "budget_exceeded",
      "timeout",
      "worker_crashed",
      "permission_denied",
      "rate_limited",
      "merge_conflict",
      "integration_failed",
      "spec_invalid",
    ])
      expectAccept("FailureClass", v);
    expectReject("FailureClass", "unknown");
  });

  it("rejects silent coercion for identifier/enum schemas", () => {
    expectReject("BackendName", 0);
    expectReject("Effort", 1);
    expectReject("RunId", 123456);
  });
});

describe("planner artifacts", () => {
  it("Command requires run and timeout_s, allows optional cwd/env, rejects extras and coercion", () => {
    expectAccept("Command", VALID_COMMAND);
    expectAccept("Command", { run: "make", cwd: "work", timeout_s: 5, env: { A: "b" } });
    expectReject("Command", { timeout_s: 5 });
    expectReject("Command", { run: "x" });
    expectReject("Command", { run: "x", timeout_s: "60" });
    expectReject("Command", { run: "x", timeout_s: 60, bogus: 1 });
  });

  it("Budget accepts empty and partial, rejects wrong types", () => {
    expectAccept("Budget", {});
    expectAccept("Budget", { max_usd: 0.5, max_tokens: 100, timeout_min: 20, max_turns: 60 });
    expectReject("Budget", { max_usd: "0.5" });
    expectReject("Budget", { max_turns: "60" });
  });

  it("Manifest requires version 1 literal and all planner fields", () => {
    const valid = {
      version: 1,
      run_id: VALID_RUN_ID,
      goal: "ship it",
      base_ref: "main",
      setup: [VALID_COMMAND],
      contracts: { files: ["src/a.ts"], typecheck: [VALID_COMMAND] },
      integration_verify: [VALID_COMMAND],
      tasks: [{ id: VALID_TASK_ID, spec: "tasks/T1.md" }],
    };
    expectAccept("Manifest", valid);
    expectAccept("Manifest", { ...valid, ecosystem: "node-ts", budget: { max_usd: 5 } });
    expectReject("Manifest", { ...valid, version: 2 });
    expectReject("Manifest", { ...valid, version: "1" });
    expectReject("Manifest", { ...valid, goal: undefined });
    expectReject("Manifest", { ...valid, tasks: [{ id: VALID_TASK_ID }] });
    expectReject("Manifest", { ...valid, extra: true });
  });

  it("TaskSpecFrontmatter requires scope and verify blocks", () => {
    const valid = {
      id: VALID_TASK_ID,
      title: "Do it",
      class: "feature",
      depends_on: [],
      read: ["src/a.ts"],
      write: ["src/a.ts"],
      create: [],
      protected: [],
      verify: [VALID_COMMAND],
    };
    expectAccept("TaskSpecFrontmatter", valid);
    expectAccept("TaskSpecFrontmatter", {
      ...valid,
      effort: "medium",
      budget: { max_usd: 0.5 },
    });
    expectReject("TaskSpecFrontmatter", { ...valid, id: "bad id" });
    expectReject("TaskSpecFrontmatter", { ...valid, verify: [] as never[] });
    expectReject("TaskSpecFrontmatter", { ...valid, verify: [{ run: "x" }] });
  });
});

describe("results", () => {
  it("VerifyResult requires capped tails plus truncated flag", () => {
    expectAccept("VerifyResult", VALID_VERIFY);
    expectAccept("VerifyResult", { ...VALID_VERIFY, exit_code: null, truncated: true });
    expectReject("VerifyResult", { ...VALID_VERIFY, truncated: undefined });
    expectReject("VerifyResult", { ...VALID_VERIFY, exit_code: "0" });
  });

  it("UsageRecord requires backend/model/tokens/cost/at with cost_source enum", () => {
    expectAccept("UsageRecord", VALID_USAGE);
    expectAccept("UsageRecord", {
      ...VALID_USAGE,
      cache_read_tokens: 1,
      cache_write_tokens: 2,
      reasoning_tokens: 3,
      cost_source: "computed",
    });
    expectReject("UsageRecord", { ...VALID_USAGE, cost_source: "estimated" });
    expectReject("UsageRecord", { ...VALID_USAGE, backend: "nope" });
    expectReject("UsageRecord", { ...VALID_USAGE, at: undefined });
  });

  it("WorkerReport requires report envelope with usage and verify arrays", () => {
    const valid = {
      task_id: VALID_TASK_ID,
      generation: 1,
      attempt: 1,
      session_id: "sess-1",
      backend: "claude",
      model: "m",
      status: "passed",
      files_changed: ["src/a.ts"],
      usage: VALID_USAGE,
      duration_ms: 100,
      verify: [VALID_VERIFY],
      denials: [],
      final_message: "DONE",
    };
    expectAccept("WorkerReport", valid);
    expectAccept("WorkerReport", {
      ...valid,
      status: "failed",
      failure_class: "verify_failed",
      effort: "low",
    });
    expectReject("WorkerReport", { ...valid, status: "done" });
    expectReject("WorkerReport", { ...valid, usage: { ...VALID_USAGE, cost_source: "x" } });
    expectReject("WorkerReport", { ...valid, denials: [{ tool: "Bash" }] as never });
  });

  it("FailurePacket requires attempts, capped diff, scope and dependents", () => {
    const report = {
      task_id: VALID_TASK_ID,
      generation: 1,
      attempt: 1,
      session_id: "sess-1",
      backend: "claude",
      model: "m",
      status: "failed",
      failure_class: "verify_failed",
      files_changed: [],
      usage: VALID_USAGE,
      duration_ms: 1,
      verify: [VALID_VERIFY],
      denials: [],
      final_message: "BLOCKED: x",
    };
    const valid = {
      run_id: VALID_RUN_ID,
      task_id: VALID_TASK_ID,
      generation: 1,
      failure_class: "verify_failed",
      spec_path: "tasks/T1.md",
      attempts: [report],
      diff: { stat: "1 file", patch_path: "packets/x.patch", truncated: false },
      verify_output: [VALID_VERIFY],
      scope_violations: [],
      worker_summary: "failed",
      related_contracts: [],
      dependents: [],
    };
    expectAccept("FailurePacket", valid);
    expectReject("FailurePacket", { ...valid, failure_class: "nope" });
    expectReject("FailurePacket", { ...valid, diff: { stat: "s" } });
  });

  it("Diagnostic severity covers error/warn/info/gate", () => {
    for (const sev of ["error", "warn", "info", "gate"])
      expectAccept("Diagnostic", { code: "L001", severity: sev, message: "m" });
    expectReject("Diagnostic", { code: "L001", severity: "fatal", message: "m" });
    expectReject("Diagnostic", { severity: "error", message: "m" });
  });
});

describe("backend layer", () => {
  it("BackendEvent union covers all nine event types and rejects unknown", () => {
    expectAccept("BackendEvent", { type: "session.started", session_id: "s" });
    expectAccept("BackendEvent", { type: "assistant.text", text: "hi" });
    expectAccept("BackendEvent", { type: "tool.call", id: "1", name: "Bash", input_summary: "x" });
    expectAccept("BackendEvent", { type: "tool.result", id: "1", ok: true, output_summary: "y" });
    expectAccept("BackendEvent", { type: "permission.denied", tool: "Bash" });
    expectAccept("BackendEvent", { type: "usage", record: VALID_USAGE, cumulative: false });
    expectAccept("BackendEvent", { type: "subagent", raw: null });
    expectAccept("BackendEvent", { type: "error", kind: "rate_limit", message: "slow" });
    expectAccept("BackendEvent", {
      type: "session.result",
      ok: true,
      final_text: "done",
      exit_code: 0,
    });
    expectReject("BackendEvent", { type: "session.unknown" });
    expectReject("BackendEvent", { type: "error", kind: "unknown_kind", message: "x" });
  });

  it("Capabilities requires pins, flags and denial signal", () => {
    const valid = {
      name: "claude",
      version_pin: "2.1.304",
      effort: true,
      structured_output: true,
      budget_flag: true,
      cost_reported: true,
      resume: true,
      permission_denial_signal: "event",
      sandbox_flag: true,
      native_subagents_headless: true,
    };
    expectAccept("Capabilities", valid);
    expectAccept("Capabilities", { ...valid, max_concurrency: 3 });
    expectReject("Capabilities", { ...valid, permission_denial_signal: "signal" });
    expectReject("Capabilities", { ...valid, name: "unknown" });
  });

  it("SpawnRequest requires role/cwd/prompt/model/permission/budget+timeout", () => {
    const valid = {
      role: "worker",
      cwd: "/tmp/w",
      prompt: "do it",
      model: "m",
      permission: { allow: [], deny: ["Agent"] },
      budget: { timeout_ms: 1000 },
    };
    expectAccept("SpawnRequest", valid);
    expectReject("SpawnRequest", { ...valid, role: "admin" });
    expectReject("SpawnRequest", { ...valid, permission: { allow: [] } });
    expectReject("SpawnRequest", { ...valid, budget: {} });
  });

  it("SessionResult kill reasons are budget/timeout/cancel only", () => {
    const valid = {
      ok: true,
      session_id: "s",
      final_text: "done",
      usage: VALID_USAGE,
      exit_code: 0,
      denials: [],
    };
    expectAccept("SessionResult", valid);
    for (const reason of ["budget", "timeout", "cancel"])
      expectAccept("SessionResult", { ...valid, killed_for: reason });
    expectReject("SessionResult", { ...valid, killed_for: "user" });
    expectReject("SessionResult", { ...valid, ok: "yes" });
  });

  it("SessionHandle / EnvReport / HarnessAdapter exist with function-bearing shapes", () => {
    async function* emptyEvents(): AsyncGenerator<never, void, void> {}
    const handle = {
      pid: 123,
      events: emptyEvents(),
      result: async () => ({
        ok: true,
        session_id: "s",
        final_text: "done",
        usage: VALID_USAGE,
        exit_code: 0,
        denials: [],
      }),
      kill: async (_reason: string) => {},
    };
    expectAccept("SessionHandle", handle);
    expectReject("SessionHandle", null);
    expectReject("SessionHandle", "handle");

    expectAccept("EnvReport", { ok: true, pin_matches: true, problems: [] });
    expectReject("EnvReport", { ok: true, problems: [] });

    expectReject("HarnessAdapter", null);
    expectReject("HarnessAdapter", {});
  });
});

describe("settings", () => {
  function validSettings() {
    return {
      backends: { claude: { version_pin: "2.1.304", max_concurrency: 3 } },
      roles: { planner: { backend: "claude", model: "m" } },
      routing: {
        feature: { backend: "claude", model: "m" },
        escalation: ["a", "b"],
      },
      pricing: { asOf: "2026-10-16", sources: ["https://example.com"], models: {} },
      budgets: {
        run: { max_usd: 5 },
        task: { max_usd: 0.5 },
        l1_replans_per_task: 2,
        l2_per_run: 2,
        planner_format_retries: 2,
        approval_threshold_usd: 2,
      },
      concurrency: { workers: 3 },
      permissions: { allow: [], deny: ["Agent"] },
      sandbox: { enabled: true },
      git: { on_scope_violation: "revert", auto_merge: false },
      instructions: { workers: "none" },
      execution: { strategy: "direct" },
    };
  }

  it("Route and PricingTable shapes", () => {
    expectAccept("Route", { backend: "claude", model: "m" });
    expectAccept("Route", { backend: "agy", model: "m", effort: "high" });
    expectReject("Route", { backend: "nope", model: "m" });
    expectAccept("PricingTable", {
      asOf: "2026-10-16",
      sources: ["https://example.com"],
      models: {},
    });
    expectReject("PricingTable", { sources: [], models: {} });
    expectReject("PricingTable", { asOf: "x", models: {} });
    expectReject("PricingTable", { asOf: "x", sources: [] });
  });

  it("Settings accepts pricing without asOf/sources but rejects extra properties", () => {
    expectAccept("Settings", validSettings());
    expectAccept("Settings", {
      ...validSettings(),
      pricing: { sources: ["u"], models: {} },
    });
    expectAccept("Settings", {
      ...validSettings(),
      pricing: { models: {} },
    });
    expectReject("Settings", {
      ...validSettings(),
      pricing: { invalid_key: "bad" },
    });
  });

  it("Settings preserves routing.escalation alongside the route map", () => {
    const parsed = schema("Settings").safeParse(validSettings());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { routing: Record<string, unknown> }).routing["escalation"]).toEqual([
        "a",
        "b",
      ]);
      expect((parsed.data as { routing: Record<string, unknown> }).routing["feature"]).toBeDefined();
    }
  });

  it("Settings rejects unknown keys (typos are errors, not ignored)", () => {
    expectReject("Settings", { ...validSettings(), unknownKey: 1 });
    expectReject("Settings", {
      ...validSettings(),
      concurrency: { workers: 3, extra: 1 },
    });
  });
});

describe("engine API plus strategy seam", () => {
  it("RunOptions mode and permission_mode enums", () => {
    const valid = {
      prompt: "do it",
      cwd: "/tmp",
      mode: "plan",
      permission_mode: "default",
    };
    expectAccept("RunOptions", valid);
    expectReject("RunOptions", { ...valid, mode: "fast" });
    expectReject("RunOptions", { ...valid, permission_mode: "yes" });
    expectReject("RunOptions", { ...valid, prompt: undefined });
  });

  it("RunSummary status and usage envelope", () => {
    const valid = {
      run_id: VALID_RUN_ID,
      status: "finished",
      tasks: {},
      usage: { total_usd: 0, by_role: {} },
      branch: "substrate/r_abc",
      exit_code: 0,
    };
    expectAccept("RunSummary", valid);
    expectReject("RunSummary", { ...valid, status: "done" });
    expectReject("RunOptions", { ...valid, status: "finished" });
  });

  it("EngineEvent is a versioned envelope with ISO ts and seq", () => {
    expectAccept("EngineEvent", {
      v: 1,
      seq: 0,
      ts: "2026-10-16T00:00:00.000Z",
      run_id: VALID_RUN_ID,
      type: "run.created",
      data: {},
    });
    expectReject("EngineEvent", {
      v: 2,
      seq: 0,
      ts: "2026-10-16T00:00:00.000Z",
      run_id: VALID_RUN_ID,
      type: "run.created",
      data: {},
    });
    expectReject("EngineEvent", {
      v: 1,
      seq: "0",
      ts: "2026-10-16T00:00:00.000Z",
      run_id: VALID_RUN_ID,
      type: "run.created",
      data: {},
    });
  });

  it("task.failed keeps its fields and takes an optional message of at most 2000 characters", () => {
    const envelope = {
      v: 1,
      seq: 3,
      ts: "2026-10-20T00:00:00.000Z",
      run_id: VALID_RUN_ID,
      type: "task.failed",
    };
    const accepts = (data: unknown) => EngineEventV1.safeParse({ ...envelope, data }).success;
    expect(accepts({ failure_class: "worker_crashed" })).toBe(true);
    expect(accepts({ failure_class: "spec_invalid", message: "Planner format retries exhausted" })).toBe(true);
    expect(accepts({ failure_class: "spec_invalid", message: "x".repeat(2000) })).toBe(true);
    expect(accepts({ failure_class: "spec_invalid", message: "x".repeat(2001) })).toBe(false);
    expect(accepts({ failure_class: "spec_invalid", message: 42 })).toBe(false);
  });

  it("Engine exposes run/resume call shapes", () => {
    expectReject("Engine", null);
    expectReject("Engine", {});
  });

  it("ExecutionStrategy reserves direct versus dispatcher only", () => {
    expectAccept("ExecutionStrategy", "direct");
    expectAccept("ExecutionStrategy", "dispatcher");
    expectReject("ExecutionStrategy", "engine-side");
    expectReject("ExecutionStrategy", "auto");
  });

  it("RoutingDecision requires rationale with solo/plan mode", () => {
    expectAccept("RoutingDecision", { mode: "solo", rationale: "trivial" });
    expectAccept("RoutingDecision", {
      mode: "plan",
      task_class: "feature",
      planner_route: "r",
      rationale: "complex",
      needs_clarification: ["q"],
    });
    expectReject("RoutingDecision", { mode: "solo" });
    expectReject("RoutingDecision", { mode: "auto", rationale: "x" });
  });
});
