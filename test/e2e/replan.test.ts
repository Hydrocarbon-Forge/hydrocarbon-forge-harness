import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as Contracts from "../../src/contracts/index.js";
import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions", "Run the replan case"];

const CONTRACT_STUB = "export {};\n";

interface EventLike {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

function events(res: RunSubstrateResult): EventLike[] {
  return res.events.map((e) => ({
    seq: e.seq,
    type: e.type,
    data: (e.data ?? {}) as Record<string, unknown>,
  }));
}

function eventsOfType(res: RunSubstrateResult, type: string): EventLike[] {
  return events(res).filter((e) => e.type === type);
}

function eventAt(res: RunSubstrateResult, type: string): EventLike | undefined {
  return eventsOfType(res, type)[0];
}

function runIdOf(res: RunSubstrateResult): string {
  return (eventAt(res, "run.created")?.data.run_id as string) ?? "";
}

function manifestFor(
  taskIds: string[],
  contractFiles: string[],
  goal: string,
): string {
  return [
    "version: 1",
    "run_id: r_REPLANE2EAAA",
    `goal: ${goal}`,
    "base_ref: main",
    "ecosystem: node-ts",
    "setup:",
    "  - run: echo setup",
    "    timeout_s: 30",
    "contracts:",
    "  files:",
    ...contractFiles.map((f) => `    - ${f}`),
    "  typecheck:",
    "    - run: echo typecheck contracts",
    "      timeout_s: 30",
    "integration_verify:",
    "  - run: echo verify all",
    "    timeout_s: 60",
    "tasks:",
    ...taskIds.flatMap((id) => [`  - id: ${id}`, `    spec: tasks/${id}.md`]),
    "",
  ].join("\n");
}

function taskSpec(options: {
  id: string;
  title: string;
  depends_on: string[];
  write: string[];
  protected: string[];
  verify: string;
  marker?: string;
}): string {
  return [
    "---",
    `id: ${options.id}`,
    `title: ${options.title}`,
    "class: feature",
    `depends_on: [${options.depends_on.join(", ")}]`,
    "read:",
    "  - contracts/types.ts",
    "write:",
    ...options.write.map((p) => `  - ${p}`),
    "create: []",
    ...(options.protected.length > 0
      ? ["protected:", ...options.protected.map((p) => `  - ${p}`)]
      : ["protected: []"]),
    "budget:",
    "  max_usd: 0.5",
    "  max_turns: 12",
    "verify:",
    `  - run: ${options.verify}`,
    "    timeout_s: 10",
    "---",
    "",
    "## Objective",
    "",
    `Write one line in the allowed file for ${options.id} and nothing else.`,
    ...(options.marker ? ["", `Spec marker: ${options.marker}.`] : []),
    "",
    "## Interface",
    "",
    "The allowed file gains the marker line.",
    "",
    "## Behavior",
    "",
    "The marker line is present after the task runs.",
    "",
    "## Invariants",
    "",
    "No other file is modified.",
    "",
    "## Edge cases",
    "",
    "The file is not rewritten, only appended.",
    "",
    "## Guardrails",
    "",
    "No network access.",
    "",
    "## Out of scope",
    "",
    "Renaming the file.",
    "",
  ].join("\n");
}

function planCall(files: Record<string, string>, reply: string): Record<string, unknown> {
  return { plan: { files }, reply: `${reply}\nPLAN READY` };
}

describe("E2E replan: the built CLI walks the escalation ladder (R3.5)", () => {
  it(
    "(a) double fail writes a packet, L1 revises the spec, and generation 2 passes with it",
    () => {
      const spec = taskSpec({
        id: "T1",
        title: "Edit the allowed file",
        depends_on: [],
        write: ["src/feature.txt"],
        protected: ["contracts/types.ts"],
        verify: "grep -q marker src/feature.txt",
      });

      const revised = taskSpec({
        id: "T1",
        title: "Edit the allowed file with the right marker",
        depends_on: [],
        write: ["src/feature.txt"],
        protected: ["contracts/types.ts"],
        verify: "grep -q revised-marker src/feature.txt",
        marker: "REVISED-SPEC-MARKER-7731",
      });

      const res = runSubstrate({
        files: {
          "src/feature.txt": "seed\n",
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall(
              {
                "manifest.yaml": manifestFor(["T1"], ["contracts/types.ts"], "Run the replan case"),
                "tasks/T1.md": spec,
                "contracts/types.ts": CONTRACT_STUB,
              },
              "wrote the plan",
            ),
            // Attempt 1 fails verify, so the L0 heal runs.
            {
              edits: { "src/feature.txt": "seed\n" },
              reply: "attempt 1: no marker\nDONE",
            },
            // Attempt 2 fails too, so the task is FAILED and the ladder takes L1.
            {
              edits: { "src/feature.txt": "seed\nwrong line\n" },
              reply: "attempt 2: still no marker\nDONE",
            },
            // L1: the planner returns a revised spec naming this task.
            {
              plan: { files: { "tasks/T1.md": revised } },
              reply: "the spec asked for the wrong marker\nREVISED T1",
            },
            // Generation 2 runs against the revised spec.
            {
              edits: { "src/feature.txt": "seed\nrevised-marker\n" },
              reply: "appended the revised marker\nDONE",
            },
          ],
        },
        args: RUN_ARGS,
      });

      try {
        const runId = runIdOf(res);
        expect(runId).toBeTruthy();
        expect(res.exitCode).toBe(0);

        const started = eventAt(res, "replan.started");
        expect(started).toBeDefined();
        expect(started?.data.task_id).toBe("T1");
        expect(started?.data.generation).toBe(2);

        const types = events(res).map((e) => e.type);
        expect(types).toContain("task.failed");
        expect(types).toContain("task.replanned");
        expect(types).toContain("replan.finished");
        expect(types).toContain("task.passed");
        expect(types).toContain("task.merged");

        // The packet on disk is the one the planner was given, and it validates.
        const packetPath = join(res.runDir as string, "packets", "T1-g1.json");
        expect(existsSync(packetPath)).toBe(true);
        const packet = Contracts.FailurePacket.parse(JSON.parse(readFileSync(packetPath, "utf8")));
        expect(packet.run_id).toBe(runId);
        expect(packet.task_id).toBe("T1");
        expect(packet.generation).toBe(1);
        expect(packet.failure_class).toBe("verify_failed");
        expect(packet.attempts.length).toBe(2);
        // verify_output is the last attempt's results, so it is not empty.
        expect(packet.verify_output.length).toBeGreaterThanOrEqual(1);
        expect(packet.verify_output[0].exit_code).not.toBe(0);
        expect(packet.dependents).toEqual([]);

        // Generation 2 runs the revised spec the planner wrote into the run directory. The
        // generation 2 worktree that held its TASK.md is removed when the run ends (R8.1).
        const revisedSpec = readFileSync(join(res.runDir as string, "tasks", "T1.md"), "utf8");
        expect(revisedSpec).toContain("REVISED-SPEC-MARKER-7731");
        expect(revisedSpec).toContain("grep -q revised-marker src/feature.txt");
        expect(
          events(res).some((e) => e.type === "task.worktree.created" && String(e.data.path).includes("T1-g2")),
        ).toBe(true);
      } finally {
        res.cleanup();
      }
    },
  );

  it(
    "(b) L2 amends the plan, invalidates the dependent that has not merged, and re-runs it",
    () => {
      const t0 = taskSpec({
        id: "T0",
        title: "Independent task that merges first",
        depends_on: [],
        write: ["src/t0.txt"],
        protected: ["contracts/types.ts"],
        verify: "grep -q t0-marker src/t0.txt",
      });
      const t1 = taskSpec({
        id: "T1",
        title: "Task that touches a protected file",
        depends_on: ["T0"],
        write: ["src/t1.txt"],
        protected: ["contracts/types.ts"],
        verify: "grep -q t1-marker src/t1.txt",
      });
      const t2 = taskSpec({
        id: "T2",
        title: "Downstream task that depends on T1",
        depends_on: ["T1"],
        write: ["src/t2.txt"],
        protected: ["contracts/types.ts"],
        verify: "grep -q t2-marker src/t2.txt",
      });

      const planFiles = {
        "manifest.yaml": manifestFor(["T0", "T1", "T2"], ["contracts/types.ts"], "Run the replan case"),
        "tasks/T0.md": t0,
        "tasks/T1.md": t1,
        "tasks/T2.md": t2,
        "contracts/types.ts": CONTRACT_STUB,
      };

      const res = runSubstrate({
        files: {
          "src/t0.txt": "base\n",
          "src/t1.txt": "base\n",
          "src/t2.txt": "base\n",
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall(planFiles, "wrote the plan"),
            // T0 merges before the failure, so it is a MERGED task when L2 runs.
            { edits: { "src/t0.txt": "base\nt0-marker\n" }, reply: "T0 done\nDONE" },
            // T1 writes a protected path, which is not a verify failure, so the ladder
            // goes straight to L2 with the L1 cap set to 0.
            {
              edits: { "contracts/types.ts": "export interface Amended { marker: string; }\n" },
              reply: "T1 touched the contract\nDONE",
            },
            // L2: the amended manifest and the new contract file.
            {
              plan: {
                files: {
                  "manifest.yaml": manifestFor(
                    ["T0", "T1", "T2"],
                    ["contracts/types.ts", "contracts/amended.ts"],
                    "Run the replan case",
                  ),
                  "contracts/amended.ts": "export interface Amended { marker: string; }\n",
                },
              },
              reply: "amended the contract and the manifest\nAMENDED",
            },
            // T1 is re-run at generation 2, then the invalidated T2 is promoted.
            { edits: { "src/t1.txt": "base\nt1-marker\n" }, reply: "T1 done\nDONE" },
            { edits: { "src/t2.txt": "base\nt2-marker\n" }, reply: "T2 done\nDONE" },
          ],
        },
        settings: {
          budgets: { l1_replans_per_task: 0, l2_per_run: 1 },
          concurrency: { workers: 1 },
        },
        args: RUN_ARGS,
      });

      try {
        const runId = runIdOf(res);
        expect(res.exitCode).toBe(0);

        const l2 = eventAt(res, "replan.l2");
        expect(l2).toBeDefined();
        expect(l2?.data.task_id).toBe("T1");

        const invalidated = eventsOfType(res, "tasks.invalidated");
        expect(invalidated.length).toBe(1);
        expect(invalidated[0].data.task_ids).toEqual(["T2"]);

        // T0 merged before the amendment, so the amendment does not reach it.
        const merged = eventsOfType(res, "task.merged").map((e) => e.data.task_id);
        expect(merged).toContain("T0");
        expect(merged).toContain("T1");
        expect(merged).toContain("T2");
        expect(invalidated[0].data.task_ids).not.toContain("T0");

        // The plan phase committed the contract stubs, and the L2 amendment committed the
        // contract it added, so the commit recorded after `replan.l2` is the amendment's.
        const commits = eventsOfType(res, "contracts.committed");
        expect(commits.length).toBe(2);
        expect(l2).toBeDefined();
        expect(commits[1].seq).toBeGreaterThan(l2!.seq);
        expect(existsSync(join(res.runDir as string, "contracts", "amended.ts"))).toBe(true);

        // The invalidated task is promoted by the scheduler and runs again.
        const worktrees = eventsOfType(res, "task.worktree.created").map((e) => e.data.path as string);
        expect(worktrees.some((p) => p.includes(`${runId}/T2-g1`))).toBe(true);
        expect(worktrees.some((p) => p.includes(`${runId}/T1-g2`))).toBe(true);
      } finally {
        res.cleanup();
      }
    },
  );

  it(
    "(c) an L1 finish line that does not name the task escalates to L2 with the reason recorded",
    () => {
      const spec = taskSpec({
        id: "T1",
        title: "Edit the allowed file",
        depends_on: [],
        write: ["src/feature.txt"],
        protected: ["contracts/types.ts"],
        verify: "grep -q marker src/feature.txt",
      });

      const res = runSubstrate({
        files: {
          "src/feature.txt": "seed\n",
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall(
              {
                "manifest.yaml": manifestFor(["T1"], ["contracts/types.ts"], "Run the replan case"),
                "tasks/T1.md": spec,
                "contracts/types.ts": CONTRACT_STUB,
              },
              "wrote the plan",
            ),
            { edits: { "src/feature.txt": "seed\n" }, reply: "attempt 1 failed\nDONE" },
            { edits: { "src/feature.txt": "seed\nnope\n" }, reply: "attempt 2 failed\nDONE" },
            // The planner writes a spec but names the wrong task, so L1 is not accepted.
            {
              plan: { files: { "tasks/T1.md": spec } },
              reply: "spec written\nREVISED T2",
            },
            {
              plan: { files: { "contracts/types.ts": CONTRACT_STUB } },
              reply: "the contract is the real problem\nAMENDED",
            },
            { edits: { "src/feature.txt": "seed\nmarker\n" }, reply: "passed on generation 2\nDONE" },
          ],
        },
        settings: {
          budgets: { l2_per_run: 1 },
          concurrency: { workers: 1 },
        },
        args: RUN_ARGS,
      });

      try {
        const started = eventsOfType(res, "replan.started");
        expect(started.length).toBe(2);
        expect(started[0].data.generation).toBe(2);
        expect(started[1].data.reason).toBe("REVISED T2");

        const l2 = eventAt(res, "replan.l2");
        expect(l2).toBeDefined();

        const types = events(res).map((e) => e.type);
        expect(types).toContain("task.replanned");
        expect(types).toContain("task.merged");
        expect(res.exitCode).toBe(0);
      } finally {
        res.cleanup();
      }
    },
  );

  it(
    "(d) reaching L3 with no question fails the task and the run with exit code 1 (R8.1)",
    () => {
      const spec = taskSpec({
        id: "T1",
        title: "Edit the allowed file",
        depends_on: [],
        write: ["src/feature.txt"],
        protected: ["contracts/types.ts"],
        verify: "grep -q marker src/feature.txt",
      });

      const res = runSubstrate({
        files: {
          "src/feature.txt": "seed\n",
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall(
              {
                "manifest.yaml": manifestFor(["T1"], ["contracts/types.ts"], "Run the replan case"),
                "tasks/T1.md": spec,
                "contracts/types.ts": CONTRACT_STUB,
              },
              "wrote the plan",
            ),
            { edits: { "src/feature.txt": "seed\n" }, reply: "attempt 1 failed\nDONE" },
            { edits: { "src/feature.txt": "seed\nnope\n" }, reply: "attempt 2 failed\nDONE" },
          ],
        },
        settings: {
          budgets: { l1_replans_per_task: 0, l2_per_run: 0 },
          concurrency: { workers: 1 },
        },
        args: RUN_ARGS,
      });

      try {
        const types = events(res).map((e) => e.type);
        expect(types).toContain("task.failed");

        // No question was asked, so nothing waits for a person: the task is failed for
        // good (no replan), and the run ends failed with the reason in its last event.
        const failed = events(res).filter((e) => e.type === "task.failed").pop();
        expect(failed?.data.can_replan).toBe(false);
        expect(types).not.toContain("run.paused");

        const finished = eventAt(res, "run.finished");
        expect(finished?.data.exit_code).toBe(1);
        expect(finished?.data.failed_tasks).toEqual(["T1"]);

        expect(res.exitCode).toBe(1);
      } finally {
        res.cleanup();
      }
    },
  );
});
