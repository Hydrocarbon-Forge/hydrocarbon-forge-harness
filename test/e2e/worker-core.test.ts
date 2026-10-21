import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";

const RUN_ARGS = [
  "run",
  "--permission-mode",
  "bypassPermissions",
  "Run the worker core case",
];

const CONTRACT_STUB = "export {};\n";

const MANIFEST = [
  "version: 1",
  "run_id: r_CCCCCCCCCCCC",
  "goal: Run the worker core case",
  "base_ref: main",
  "ecosystem: node-ts",
  "setup:",
  "  - run: echo setup",
  "    timeout_s: 30",
  "contracts:",
  "  files:",
  "    - contracts/types.ts",
  "  typecheck:",
  "    - run: echo typecheck contracts",
  "      timeout_s: 30",
  "integration_verify:",
  "  - run: echo verify all",
  "    timeout_s: 60",
  "tasks:",
  "  - id: T1",
  "    spec: tasks/T1.md",
  "",
].join("\n");

function taskSpec(options: {
  write: string[];
  protected: string[];
  verify: string;
}): string {
  return [
    "---",
    "id: T1",
    "title: Edit the allowed file",
    "class: feature",
    "depends_on: []",
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
    "Write one line in the allowed file and nothing else.",
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

function planCall(spec: string): Record<string, unknown> {
  return {
    plan: {
      files: {
        "manifest.yaml": MANIFEST,
        "tasks/T1.md": spec,
        "contracts/types.ts": CONTRACT_STUB,
      },
    },
    reply: "wrote the plan for the worker core case\nPLAN READY",
  };
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  }).trim();
}

function eventTypes(res: RunSubstrateResult): string[] {
  return res.events.map((e) => e.type);
}

function dataOf(res: RunSubstrateResult, type: string): Record<string, unknown> | undefined {
  const event = res.events.find((e) => e.type === type);
  return event?.data as Record<string, unknown> | undefined;
}

function runIdOf(res: RunSubstrateResult): string {
  return (dataOf(res, "run.created")?.run_id as string) ?? "";
}

describe("E2E worker core: the built CLI runs the worker path (R3.3)", () => {
  it("(a) a task that edits its write file passes and the engine commits on the task branch", () => {
    const res = runSubstrate({
      files: {
        "src/feature.txt": "seed\n",
        "contracts/types.ts": "export {};\n",
      },
      scenario: {
        calls: [
          planCall(
            taskSpec({ write: ["src/feature.txt"], protected: ["contracts/types.ts"], verify: "grep -q marker src/feature.txt" })
          ),
          {
            edits: { "src/feature.txt": "seed\nmarker\n" },
            reply: "appended the marker\nDONE",
          },
        ],
      },
      args: RUN_ARGS,
    });

    try {
      const runId = runIdOf(res);
      expect(runId).toBeTruthy();
      expect(eventTypes(res)).toContain("task.passed");
      expect(res.exitCode).toBe(0);

      // The task branch is removed when the run finishes (R8.1); its commit is read from the
      // run branch, which holds it as the second parent of the `merge: task T1` commit.
      const taskCommit = gitIn(res.repoDir, ["log", "-1", "--format=%H", "--grep=feat(task): T1", `substrate/runs/${runId}`]);
      expect(taskCommit).not.toBe("");
      const messages = gitIn(res.repoDir, ["log", "--format=%s", "-1", taskCommit]).split("\n");
      expect(messages[0]).toBe("feat(task): T1");

      // The commit contains only the allowed path.
      const changed = gitIn(res.repoDir, ["show", "--stat", "--format=", taskCommit]).split("\n");
      expect(changed.some((line) => line.includes("src/feature.txt"))).toBe(true);
    } finally {
      res.cleanup();
    }
  });

  it("(b) an out-of-scope edit is reverted and verify still decides the task", () => {
    const spec = taskSpec({
      write: ["src/feature.txt"],
      protected: [],
      // The verify command only passes when the out-of-scope file is back at its
      // base content: the revert, not the worker's reply, decides the outcome.
      verify: "grep -q base src/other.txt && grep -q marker src/feature.txt",
    });

    const res = runSubstrate({
      files: {
        "src/feature.txt": "seed\n",
        "src/other.txt": "base\n",
        "contracts/types.ts": "export {};\n",
      },
      scenario: {
        calls: [
          planCall(spec),
          {
            edits: {
              "src/feature.txt": "seed\nmarker\n",
              "src/other.txt": "out of scope change\n",
            },
            // The worker's word is not the test: it claims failure, verify decides.
            reply: "cannot complete the task\nBLOCKED",
          },
        ],
      },
      args: RUN_ARGS,
    });

    try {
      const runId = runIdOf(res);
      const scope = dataOf(res, "task.scope.checked");
      expect(scope).toBeDefined();
      expect((scope?.violations as string[]) ?? []).toContain("src/other.txt");

      // The out-of-scope file is back at its base content, and the verify command ran against
      // that state, so the task passed. The finished run removes the worktree (R8.1), so the
      // reverted file is read from the run branch.
      const worktree = join(res.repoDir, ".substrate", "worktrees", runId, "T1-g1");
      expect(existsSync(worktree)).toBe(false);
      expect(gitIn(res.repoDir, ["show", `substrate/runs/${runId}:src/other.txt`])).toBe("base");
      expect(eventTypes(res)).toContain("task.passed");
    } finally {
      res.cleanup();
    }
  });

  it("(c) a protected-file edit emits task.failed with failure_class protected_modified", () => {
    const spec = taskSpec({
      write: ["src/feature.txt"],
      protected: ["contracts/types.ts"],
      verify: "grep -q marker src/feature.txt",
    });

    const res = runSubstrate({
      files: {
        "src/feature.txt": "seed\n",
        "contracts/types.ts": "export {};\n",
      },
      scenario: {
        calls: [
          planCall(spec),
          {
            edits: {
              "src/feature.txt": "seed\nmarker\n",
              "contracts/types.ts": "export {};\n// touched by the worker\n",
            },
            reply: "DONE",
          },
        ],
      },
      args: RUN_ARGS,
    });

    try {
      const failed = dataOf(res, "task.failed");
      expect(failed).toBeDefined();
      expect(failed?.failure_class).toBe("protected_modified");
      expect(eventTypes(res)).not.toContain("task.passed");
    } finally {
      res.cleanup();
    }
  });

  it("(d) the worktree path contains the run id", () => {
    const res = runSubstrate({
      files: {
        "src/feature.txt": "seed\n",
        "contracts/types.ts": "export {};\n",
      },
      scenario: {
        calls: [
          planCall(taskSpec({ write: ["src/feature.txt"], protected: [], verify: "grep -q marker src/feature.txt" })),
          { edits: { "src/feature.txt": "seed\nmarker\n" }, reply: "DONE" },
        ],
      },
      args: RUN_ARGS,
    });

    try {
      const runId = runIdOf(res);
      const worktreeEvent = dataOf(res, "task.worktree.created");
      expect(worktreeEvent).toBeDefined();
      const path = worktreeEvent?.path as string;
      expect(path).toContain(runId);
      expect(path).toContain("T1-g1");

      // The run branch is what a finished run keeps (R8.1); the task branch is removed.
      const branch = gitIn(res.repoDir, ["branch", "--list", `substrate/runs/${runId}`]);
      expect(branch).toContain(`substrate/runs/${runId}`);
    } finally {
      res.cleanup();
    }
  });
});
