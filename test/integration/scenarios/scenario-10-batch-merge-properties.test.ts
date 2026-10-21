import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Manifest, RunId } from "../../../src/contracts/index.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
  loadEngine,
  writePlanFiles,
  readEventLog,
  type ScenarioEnv,
  type EngineModule,
} from "./helpers.js";
import {
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../roles/fixtures.js";

// Live batch merge properties: src/engine/actions/merge.ts over the live functions in
// src/git/merger.ts. Every integration verify run is recorded by a command that runs in
// the integration worktree and appends one JSON line: the run ref sha at that moment and
// the sorted src/ listing. The log file lives outside the user's checkout.

interface VerifyRecord {
  ref: string;
  files: string[];
}

interface TaskInput {
  id: string;
  file: string;
  // "create": the task creates `file`; "write": the task edits `file`, which must exist.
  mode?: "create" | "write";
}

interface BatchRun {
  events: ReturnType<typeof readEventLog>;
  verifyRuns: VerifyRecord[];
  runRef: string;
  // The run branch starts at the contract commit; the batch checkpoint is that commit.
  contractsSha: string;
}

function taskSpec(id: string, file: string, mode: "create" | "write"): string {
  return sampleValidTaskSpecMarkdown({
    frontmatter: {
      id,
      title: `Batch task ${id}`,
      depends_on: [],
      write: mode === "write" ? [file] : [],
      create: mode === "create" ? [file] : [],
      verify: [{ run: `echo verify ${id}`, timeout_s: 30 }],
    },
  });
}

// Writes a verify script outside the repo. It fails while `badFile` exists in the
// integration worktree (its cwd). Returns the command for the manifest.
function recordingVerifyCommand(scriptDir: string, logPath: string, runRef: string, badFile?: string): string {
  const scriptPath = join(scriptDir, "record-integration.cjs");
  const exitRule = badFile
    ? `process.exit(fs.existsSync(${JSON.stringify(badFile)}) ? 1 : 0);`
    : "process.exit(0);";
  writeFileSync(
    scriptPath,
    [
      'const fs = require("node:fs");',
      'const { execFileSync } = require("node:child_process");',
      `const ref = execFileSync("git", ["rev-parse", "--verify", "-q", ${JSON.stringify(runRef)}], { encoding: "utf8" }).trim();`,
      'const files = fs.existsSync("src") ? fs.readdirSync("src").sort() : [];',
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ ref, files }) + "\\n");`,
      exitRule,
      "",
    ].join("\n"),
    "utf8"
  );
  return `node ${scriptPath}`;
}

function readVerifyLog(path: string): VerifyRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as VerifyRecord);
}

describe("Scenario 10b: live batch merge properties (merge.ts over merger.ts)", () => {
  let env: ScenarioEnv;
  let engineMod: EngineModule;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;
  let scriptDir: string;

  beforeAll(async () => {
    engineMod = await loadEngine();
  });

  beforeEach(async () => {
    env = await setupScenarioEnv("10b-batch-merge");
    scriptDir = mkdtempSync(join(tmpdir(), "sub-batch-props-"));
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
    rmSync(scriptDir, { recursive: true, force: true });
  });

  async function runBatch(runId: RunId, tasks: TaskInput[], badFile?: string): Promise<BatchRun> {
    const runRef = `refs/heads/substrate/runs/${runId}`;
    const logPath = join(scriptDir, `integration-${runId}.jsonl`);
    const verifyCmd = recordingVerifyCommand(scriptDir, logPath, runRef, badFile);

    fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      ...tasks.map(({ id, file }) => ({
        edits: { [file]: `// ${id}\n` },
        reply: `Worker ${id} done`,
      })),
    ]);

    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: tasks.map(({ id }) => ({ id, spec: `tasks/${id}.md` })),
      integration_verify: [{ run: verifyCmd, timeout_s: 30 }],
    };
    const specs: Record<string, string> = {};
    for (const { id, file, mode } of tasks) {
      specs[`tasks/${id}.md`] = taskSpec(id, file, mode ?? "create");
    }
    writePlanFiles(env.repoRoot, runId, manifest, specs, {
      "contracts/types.ts": sampleValidContractStub(),
    });

    const engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });
    await engine.run({
      prompt: "Batch merge properties",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
    });

    const events = readEventLog(env.runDir, runId);
    const contracts = events.find((e) => e.type === "contracts.committed");
    return {
      events,
      verifyRuns: readVerifyLog(logPath),
      runRef,
      contractsSha: (contracts?.data as { commit_sha: string }).commit_sha,
    };
  }

  it("a passing batch records the pre-batch sha, advances the run ref in batch order and keeps the user's checkout", async () => {
    const runId: RunId = "r_LLLLLLABCDEF";
    const headBefore = env.testRepo.git(["rev-parse", "HEAD"]);
    const branchBefore = env.testRepo.git(["rev-parse", "--abbrev-ref", "HEAD"]);

    const untrackedPath = join(env.repoRoot, "user-notes.txt");
    const untrackedContent = "personal notes must survive the batch\n";
    writeFileSync(untrackedPath, untrackedContent, "utf8");

    const run = await runBatch(runId, [
      { id: "T1", file: "src/t1.ts" },
      { id: "T2", file: "src/t2.ts" },
      { id: "T3", file: "src/t3.ts" },
    ]);

    const batchEvents = run.events.filter((e) => e.type === "batch.merged");
    expect(batchEvents).toHaveLength(1);
    expect((batchEvents[0]?.data as any).batch).toEqual(["T1", "T2", "T3"]);

    // (1) the batch records the pre-batch sha, which is the run ref before the merges.
    const preBatchSha: string = (batchEvents[0]?.data as any).checkpoint_ref;
    expect(preBatchSha).toBe(run.contractsSha);

    // (1) the run ref advanced: its first-parent history since the checkpoint holds one merge
    // per task, oldest first in batch order, and each merge's second parent is that task's branch tip.
    const runHead = env.testRepo.git(["rev-parse", run.runRef]);
    expect(runHead).not.toBe(preBatchSha);
    const subjects = env.testRepo
      .git(["log", "--first-parent", "--reverse", "--format=%s", `${preBatchSha}..${runHead}`])
      .split("\n");
    expect(subjects).toEqual(["merge: task T1", "merge: task T2", "merge: task T3"]);

    // (e) the merge commits follow batch order in the parent chain: each first parent is the
    // previous merge (the checkpoint for the first) and each second parent is that task's tip.
    const chain = env.testRepo
      .git(["rev-list", "--parents", "--first-parent", "--reverse", `${preBatchSha}..${runHead}`])
      .split("\n")
      .map((line) => line.split(" "));
    expect(chain).toHaveLength(3);
    let previous = preBatchSha;
    for (const [i, taskId] of ["T1", "T2", "T3"].entries()) {
      const [sha, firstParent, secondParent] = chain[i] ?? [];
      expect(firstParent).toBe(previous);
      // The finished run removes the task branches (R8.1); the second parent is still the
      // task's commit, which must exist.
      expect(env.testRepo.git(["cat-file", "-t", secondParent ?? ""])).toBe("commit");
      previous = sha ?? "";
    }
    expect(previous).toBe(runHead);

    // Integration verify runs: the base check (nothing merged yet), the batch (all three
    // tasks, run ref still at the checkpoint), then the post-run integration on the merged ref.
    expect(run.verifyRuns[0]).toEqual({ ref: preBatchSha, files: [] });
    expect(run.verifyRuns[1]).toEqual({ ref: preBatchSha, files: ["t1.ts", "t2.ts", "t3.ts"] });
    expect(run.verifyRuns[2]?.ref).toBe(runHead);

    // The user's checkout: HEAD, branch and the untracked file are unchanged.
    expect(env.testRepo.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(env.testRepo.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branchBefore);
    expect(readFileSync(untrackedPath, "utf8")).toBe(untrackedContent);
  });

  it("a failing batch bisects in batch order, stops at the culprit, merges nothing and leaves the run ref and the user's checkout alone", async () => {
    const runId: RunId = "r_MMMMMMABCDEF";
    const headBefore = env.testRepo.git(["rev-parse", "HEAD"]);

    const untrackedPath = join(env.repoRoot, "user-notes.txt");
    const untrackedContent = "untracked bytes across bisect\n";
    writeFileSync(untrackedPath, untrackedContent, "utf8");

    const run = await runBatch(
      runId,
      [
        { id: "T1", file: "src/t1.ts" },
        { id: "T2", file: "src/bad.ts" },
        { id: "T3", file: "src/t3.ts" },
      ],
      "src/bad.ts"
    );

    const culpritIdx = run.events.findIndex((e) => e.type === "bisect.culprit");
    expect(culpritIdx).toBeGreaterThan(-1);
    expect((run.events[culpritIdx]?.data as any).culprit_task_id).toBe("T2");

    // (c) nothing merged and the run ref never moved: no task.merged or batch.merged before the culprit.
    const mergedBeforeCulprit = run.events
      .slice(0, culpritIdx)
      .filter((e) => e.type === "task.merged" || e.type === "batch.merged");
    expect(mergedBeforeCulprit).toEqual([]);

    // (a) and (b): the bisect sequence. Base check, batch (fails), bisect T1 (passes), bisect T2
    // (fails). The scan stops at T2, so T3 is never merged into the integration worktree.
    // Three integration verify runs for the batch and the bisect, within 1 + N = 4.
    const [base, batch, bisectT1, bisectT2] = run.verifyRuns;
    expect(base).toEqual({ ref: run.contractsSha, files: [] });
    expect(batch).toEqual({ ref: run.contractsSha, files: ["bad.ts", "t1.ts", "t3.ts"] });
    expect(bisectT1).toEqual({ ref: run.contractsSha, files: ["t1.ts"] });
    expect(bisectT2).toEqual({ ref: run.contractsSha, files: ["bad.ts", "t1.ts"] });
    expect(run.verifyRuns.slice(1, 4).length).toBeLessThanOrEqual(1 + 3);

    // (c) the run ref held the checkpoint at every integration verify of the failing batch.
    for (const record of run.verifyRuns.slice(0, 4)) {
      expect(record.ref).toBe(run.contractsSha);
    }
    expect(env.testRepo.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(untrackedPath, "utf8")).toBe(untrackedContent);
  });

  it("a single-task batch that fails verify names that task as culprit and leaves nothing merged", async () => {
    const runId: RunId = "r_NNNNNNABCDEF";

    const run = await runBatch(runId, [{ id: "T1", file: "src/bad.ts" }], "src/bad.ts");

    const culpritEvt = run.events.find((e) => e.type === "bisect.culprit");
    expect((culpritEvt?.data as any).culprit_task_id).toBe("T1");

    const culpritIdx = run.events.indexOf(culpritEvt!);
    expect(
      run.events
        .slice(0, culpritIdx)
        .filter((e) => e.type === "task.merged" || e.type === "batch.merged")
    ).toEqual([]);

    // Base check, batch (fails), bisect (fails): 1 + N = 2 batch and bisect runs.
    const [base, batch, bisect] = run.verifyRuns;
    expect(base).toEqual({ ref: run.contractsSha, files: [] });
    expect(batch).toEqual({ ref: run.contractsSha, files: ["bad.ts"] });
    expect(bisect).toEqual({ ref: run.contractsSha, files: ["bad.ts"] });
    expect(run.verifyRuns.slice(1, 3).length).toBeLessThanOrEqual(1 + 1);
    expect(env.testRepo.git(["rev-parse", run.runRef])).toBeTruthy();
  });
  it("a merge conflict in a batch halts it without verifying or advancing the run ref, and the user's checkout is untouched", async () => {
    const runId: RunId = "r_OOOOOOABCDEF";
    // Both tasks edit the same tracked file, so the second merge of the batch conflicts.
    env.testRepo.commitFile("src/shared.ts", "export const shared = 0;\n", "base shared");
    const headBefore = env.testRepo.git(["rev-parse", "HEAD"]);

    const untrackedPath = join(env.repoRoot, "user-notes.txt");
    const untrackedContent = "untracked bytes across a conflict\n";
    writeFileSync(untrackedPath, untrackedContent, "utf8");

    const run = await runBatch(runId, [
      { id: "T1", file: "src/shared.ts", mode: "write" },
      { id: "T2", file: "src/shared.ts", mode: "write" },
    ]);

    const conflictEvt = run.events.find((e) => e.type === "merge.conflict");
    expect((conflictEvt?.data as any).task_id).toBe("T2");
    expect((conflictEvt?.data as any).conflict_files).toEqual(["src/shared.ts"]);

    // (c) the conflicting task is dropped without a replan: failed for merge_conflict, and
    // the run goes on with the task that merged first (R8.1).
    const failed = run.events.find((e) => e.type === "task.failed" && (e.data as any).task_id === "T2");
    expect((failed?.data as any).failure_class).toBe("merge_conflict");
    expect((failed?.data as any).can_replan).toBe(false);
    expect((failed?.data as any).detail).toContain("T1");
    expect(run.events.filter((e) => e.type === "task.merged").map((e) => (e.data as any).task_id)).toEqual(["T1"]);
    const runSubjects = env.testRepo
      .git(["log", "--first-parent", "--reverse", "--format=%s", `${run.contractsSha}..${run.runRef}`])
      .split("\n");
    expect(runSubjects).toEqual(["merge: task T1"]);

    // The base check ran at main, which holds the committed shared file; the conflicting
    // batch itself never reached its integration verify.
    expect(run.verifyRuns[0]).toEqual({ ref: run.contractsSha, files: ["shared.ts"] });

    // (d) the user's checkout keeps HEAD and the untracked file.
    expect(env.testRepo.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(untrackedPath, "utf8")).toBe(untrackedContent);
  });
});
