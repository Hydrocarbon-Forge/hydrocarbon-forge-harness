import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions", "Merge integration test"];

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

function manifestFor(
  taskIds: string[],
  contractFiles: string[],
  goal: string,
  integrationVerifyCmd = "echo verify all"
): string {
  return [
    "version: 1",
    "run_id: r_MRGEINTRAAAA",
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
    `  - run: ${integrationVerifyCmd}`,
    "    timeout_s: 60",
    "tasks:",
    ...taskIds.flatMap((id) => [`  - id: ${id}`, `    spec: tasks/${id}.md`]),
    "",
  ].join("\n");
}

function taskSpec(options: {
  id: string;
  title: string;
  depends_on?: string[];
  write?: string[];
  create?: string[];
  protected?: string[];
  verify: string;
}): string {
  const dependsOn = options.depends_on ?? [];
  const write = options.write ?? [];
  const create = options.create ?? [];
  const prot = options.protected ?? [];

  return [
    "---",
    `id: ${options.id}`,
    `title: ${options.title}`,
    "class: feature",
    `depends_on: [${dependsOn.join(", ")}]`,
    "read:",
    "  - contracts/types.ts",
    write.length > 0 ? "write:" : "write: []",
    ...write.map((p) => `  - ${p}`),
    create.length > 0 ? "create:" : "create: []",
    ...create.map((p) => `  - ${p}`),
    prot.length > 0 ? "protected:" : "protected: []",
    ...prot.map((p) => `  - ${p}`),
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
    `Objective for ${options.id}.`,
    "",
    "## Interface",
    "",
    "Interface description.",
    "",
    "## Behavior",
    "",
    "Behavior description.",
    "",
    "## Invariants",
    "",
    "No other file is modified.",
    "",
    "## Edge cases",
    "",
    "None.",
    "",
    "## Guardrails",
    "",
    "No network access.",
    "",
    "## Out of scope",
    "",
    "None.",
    "",
  ].join("\n");
}

function planCall(files: Record<string, string>, reply = "wrote plan"): Record<string, unknown> {
  return { plan: { files }, reply: `${reply}\nPLAN READY` };
}

describe("E2E merge & integration worktree (R3.6)", () => {
  it(
    "(a) a merge conflict between two tasks drops the loser without a replan (merge.conflict then task.failed with merge_conflict)",
    () => {
      // Both tasks edit the same shared file in parallel
      const t1Spec = taskSpec({
        id: "T1",
        title: "Edit shared file A",
        write: ["src/shared.txt"],
        verify: "grep -q t1-marker src/shared.txt",
      });

      const t2Spec = taskSpec({
        id: "T2",
        title: "Edit shared file B (conflicts with T1)",
        write: ["src/shared.txt"],
        verify: "grep -q t2-marker src/shared.txt",
      });

      const res = runSubstrate({
        files: {
          "src/shared.txt": "initial shared content\n",
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall({
              "manifest.yaml": manifestFor(["T1", "T2"], ["contracts/types.ts"], "Conflict run"),
              "tasks/T1.md": t1Spec,
              "tasks/T2.md": t2Spec,
              "contracts/types.ts": CONTRACT_STUB,
            }),
            // T1 worker modifies src/shared.txt (tagged: with two workers at once, R8.3)
            {
              task: "T1",
              edits: { "src/shared.txt": "t1-marker\n" },
              reply: "T1 completed\nDONE",
            },
            // T2 worker modifies src/shared.txt with conflicting lines
            {
              task: "T2",
              edits: { "src/shared.txt": "t2-marker\n" },
              reply: "T2 completed\nDONE",
            },
          ],
        },
        settings: {
          concurrency: { workers: 2 },
        },
        args: RUN_ARGS,
      });

      try {
        const types = events(res).map((e) => e.type);

        // Verify that merge.conflict was emitted
        expect(types).toContain("merge.conflict");
        const conflictEvt = eventAt(res, "merge.conflict");
        expect(conflictEvt).toBeDefined();
        // R8.3: whichever task passes first merges; the other one conflicts with it.
        const loser = String(conflictEvt?.data.task_id);
        expect(["T1", "T2"]).toContain(loser);
        const winner = loser === "T1" ? "T2" : "T1";

        // Verify that task.failed was emitted with merge_conflict
        const failedEvts = eventsOfType(res, "task.failed");
        const conflictFailed = failedEvts.find(
          (e) => e.data.task_id === loser && e.data.failure_class === "merge_conflict"
        );
        expect(conflictFailed).toBeDefined();

        // R8.1: the loser's change is dropped, not replanned: it fails for good and the
        // event names the task it collided with.
        expect(conflictFailed?.data.can_replan).toBe(false);
        expect(String(conflictFailed?.data.detail)).toContain(winner);
        expect(types).not.toContain("replan.started");
      } finally {
        res.cleanup();
      }
    }
  );

  it(
    "(b) an integration failure caused by one task: bisect.culprit names that task",
    () => {
      const t1Spec = taskSpec({
        id: "T1",
        title: "Clean task",
        create: ["src/t1.txt"],
        verify: "test -f src/t1.txt",
      });

      const t2Spec = taskSpec({
        id: "T2",
        title: "Task that breaks integration verify",
        create: ["src/bad.txt"],
        verify: "test -f src/bad.txt",
      });

      // Integration verify fails if src/bad.txt exists
      const integrationCmd = 'node -e "if (require(\'fs\').existsSync(\'src/bad.txt\')) process.exit(1); else process.exit(0);"';

      const res = runSubstrate({
        files: {
          "contracts/types.ts": CONTRACT_STUB,
        },
        scenario: {
          calls: [
            planCall({
              "manifest.yaml": manifestFor(
                ["T1", "T2"],
                ["contracts/types.ts"],
                "Bisect run",
                integrationCmd
              ),
              "tasks/T1.md": t1Spec,
              "tasks/T2.md": t2Spec,
              "contracts/types.ts": CONTRACT_STUB,
            }),
            // T1 worker creates clean file
            {
              edits: { "src/t1.txt": "clean t1 content\n" },
              reply: "T1 finished\nDONE",
            },
            // T2 worker creates culprit file
            {
              edits: { "src/bad.txt": "bad culprit content\n" },
              reply: "T2 finished\nDONE",
            },
          ],
        },
        args: RUN_ARGS,
      });

      try {
        const types = events(res).map((e) => e.type);

        // Bisect must start
        expect(types).toContain("bisect.started");

        // Bisect culprit must isolate T2
        expect(types).toContain("bisect.culprit");
        const culpritEvt = eventAt(res, "bisect.culprit");
        expect(culpritEvt).toBeDefined();
        expect(culpritEvt?.data.culprit_task_id).toBe("T2");

        // Culprit task fails with failure_class: "integration_failed"
        const failedEvts = eventsOfType(res, "task.failed");
        const culpritFailed = failedEvts.find(
          (e) => e.data.task_id === "T2" && e.data.failure_class === "integration_failed"
        );
        expect(culpritFailed).toBeDefined();
      } finally {
        res.cleanup();
      }
    }
  );

  it(
    "(c) the user's checkout keeps an untracked file, its branch name, and its HEAD sha across a passing run",
    () => {
      const repo = createE2ERepo({
        "contracts/types.ts": CONTRACT_STUB,
      });

      const untrackedFile = "user-notes.txt";
      const untrackedContent = "personal notes must not be touched\n";
      writeFileSync(join(repo.dir, untrackedFile), untrackedContent, "utf8");

      const headBefore = repo.git(["rev-parse", "HEAD"]);
      const branchBefore = repo.git(["rev-parse", "--abbrev-ref", "HEAD"]);

      const t1Spec = taskSpec({
        id: "T1",
        title: "Single task passing run",
        create: ["src/t1.txt"],
        verify: "test -f src/t1.txt",
      });

      const res = runSubstrate({
        repo,
        scenario: {
          calls: [
            planCall({
              "manifest.yaml": manifestFor(["T1"], ["contracts/types.ts"], "Passing run"),
              "tasks/T1.md": t1Spec,
              "contracts/types.ts": CONTRACT_STUB,
            }),
            {
              edits: { "src/t1.txt": "hello\n" },
              reply: "T1 passed\nDONE",
            },
          ],
        },
        args: RUN_ARGS,
      });

      try {
        expect(res.exitCode).toBe(0);

        // Untracked file is preserved byte-identically
        const fullUntrackedPath = join(repo.dir, untrackedFile);
        expect(existsSync(fullUntrackedPath)).toBe(true);
        expect(readFileSync(fullUntrackedPath, "utf8")).toBe(untrackedContent);

        // Branch name is untouched
        const branchAfter = repo.git(["rev-parse", "--abbrev-ref", "HEAD"]);
        expect(branchAfter).toBe(branchBefore);

        // HEAD sha in the user's checkout is untouched
        const headAfter = repo.git(["rev-parse", "HEAD"]);
        expect(headAfter).toBe(headBefore);
      } finally {
        res.cleanup();
      }
    }
  );

  it(
    "(d) a modified tracked file in the user's checkout is not overwritten and does not stop the run (R8.2: the run finishes; the landing checks the checkout)",
    () => {
      const repo = createE2ERepo({
        "src/tracked.txt": "initial tracked file\n",
        "contracts/types.ts": CONTRACT_STUB,
      });

      const dirtyContent = "user has uncommitted edits here\n";

      const t1Spec = taskSpec({
        id: "T1",
        title: "Should refuse to merge due to dirty checkout",
        write: ["src/tracked.txt"],
        verify: "test -f src/tracked.txt",
      });

      const res = runSubstrate({
        repo,
        beforeRun: (r) => {
          // Dirties the tracked file without committing
          writeFileSync(join(r.dir, "src/tracked.txt"), dirtyContent, "utf8");
        },
        scenario: {
          calls: [
            planCall({
              "manifest.yaml": manifestFor(["T1"], ["contracts/types.ts"], "Dirty checkout test"),
              "tasks/T1.md": t1Spec,
              "contracts/types.ts": CONTRACT_STUB,
            }),
            {
              edits: { "src/tracked.txt": "worker change\n" },
              reply: "T1 passed\nDONE",
            },
          ],
        },
        args: RUN_ARGS,
      });

      try {
        // R8.2: the batch merges into the run branch without touching the checkout, so the run
        // finishes (exit 0) and the uncommitted file is left alone; nothing lands without --merge.
        expect(res.exitCode).toBe(0);
        const finishedEvt = eventAt(res, "run.finished");
        expect(finishedEvt).toBeDefined();
        expect(finishedEvt?.data.exit_code).toBe(0);
        expect(finishedEvt?.data.reason).toBeUndefined();
        expect(res.stdout).toContain("NOT merged into");

        // The modified tracked file was NOT overwritten or lost
        const actualContent = readFileSync(join(repo.dir, "src/tracked.txt"), "utf8");
        expect(actualContent).toBe(dirtyContent);
      } finally {
        res.cleanup();
      }
    }
  );
});
