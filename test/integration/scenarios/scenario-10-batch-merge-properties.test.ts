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
      // Tagged by task: the workers of a batch run side by side (R8.3), so a positional call could go to the wrong task.
      ...tasks.map(({ id, file }) => ({
        task: id,
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

    // R8.3: a task merges as soon as it passes, so the batches depend on when each task finished. The
    // batches together hold every task once, in merge order, and each one checkpoints the run ref as
    // the batch before it left it.
    const batchEvents = run.events.filter((e) => e.type === "batch.merged");
    const batches = batchEvents.map((e) => e.data as { batch: string[]; checkpoint_ref: string });
    const mergeOrder = batches.flatMap((b) => b.batch);
    expect([...mergeOrder].sort()).toEqual(["T1", "T2", "T3"]);
    for (const b of batches) expect([...b.batch]).toEqual([...b.batch].sort());

    // (1) the first batch records the pre-batch sha, which is the run ref before the merges.
    const preBatchSha: string = batches[0]?.checkpoint_ref ?? "";
    expect(preBatchSha).toBe(run.contractsSha);

    // (1) the run ref advanced: its first-parent history since the checkpoint holds one merge
    // per task, oldest first in merge order, and each merge's second parent is that task's branch tip.
    const runHead = env.testRepo.git(["rev-parse", run.runRef]);
    expect(runHead).not.toBe(preBatchSha);
    const subjects = env.testRepo
      .git(["log", "--first-parent", "--reverse", "--format=%s", `${preBatchSha}..${runHead}`])
      .split("\n");
    expect(subjects).toEqual(mergeOrder.map((id) => `merge: task ${id}`));

    // Each batch checkpoints the run ref after the merges before it: the merge commit that closes
    // the batches so far (the checkpoint itself before the first batch).
    const chain = env.testRepo
      .git(["rev-list", "--parents", "--first-parent", "--reverse", `${preBatchSha}..${runHead}`])
      .split("\n")
      .map((line) => line.split(" "));
    expect(chain).toHaveLength(mergeOrder.length);
    let merged = 0;
    for (const b of batches) {
      const before = merged === 0 ? preBatchSha : chain[merged - 1]?.[0];
      expect(b.checkpoint_ref).toBe(before);
      merged += b.batch.length;
    }

    // (e) the merge commits follow merge order in the parent chain: each first parent is the
    // previous merge (the checkpoint for the first) and each second parent is that task's tip.
    let previous = preBatchSha;
    for (const [i] of mergeOrder.entries()) {
      const [sha, firstParent, secondParent] = chain[i] ?? [];
      expect(firstParent).toBe(previous);
      // The finished run removes the task branches (R8.1); the second parent is still the
      // task's commit, which must exist.
      expect(env.testRepo.git(["cat-file", "-t", secondParent ?? ""])).toBe("commit");
      previous = sha ?? "";
    }
    expect(previous).toBe(runHead);

    // R9.1: nothing is verified between merges. The base check runs once, on the contract commit (nothing
    // merged yet), and one integration verify runs on the merged run ref after the last merge.
    // The base check reads the run ref as it is at the gate (past the merges), so only its files are asserted.
    expect(run.verifyRuns.map((r) => r.files)).toEqual([[], ["t1.ts", "t2.ts", "t3.ts"]]);
    expect(run.verifyRuns[1]?.ref).toBe(runHead);

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

    // R9.1: every task merges as it passes, with no verify between merges, so the culprit is merged before
    // the one integration verify runs. That verify is the one that fails, on the run ref holding its file.
    const mergedIds = run.events.filter((e) => e.type === "task.merged").map((e) => (e.data as any).task_id);
    expect([...mergedIds].sort()).toEqual(["T1", "T2", "T3"]);
    const lastMergeIdx = Math.max(...run.events.map((e, i) => (e.type === "task.merged" ? i : -1)));
    expect(run.events.findIndex((e) => e.type === "integration.started")).toBeGreaterThan(lastMergeIdx);
    const runHead = env.testRepo.git(["rev-parse", run.runRef]);
    expect(env.testRepo.git(["ls-tree", "-r", "--name-only", run.runRef, "src"]).split("\n")).toContain("src/bad.ts");

    // The base check, the final verify on the run ref (it fails), then the bisect's prefix that holds only T2.
    expect(run.verifyRuns[0]?.files).toEqual([]);
    expect(run.verifyRuns[1]?.ref).toBe(runHead);
    expect(run.verifyRuns[1]?.files).toContain("bad.ts");
    expect(run.verifyRuns.length).toBeGreaterThanOrEqual(3);
    expect(env.testRepo.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(untrackedPath, "utf8")).toBe(untrackedContent);
  });

  it("a single-task batch that fails verify names that task as culprit and leaves nothing merged", async () => {
    const runId: RunId = "r_NNNNNNABCDEF";

    const run = await runBatch(runId, [{ id: "T1", file: "src/bad.ts" }], "src/bad.ts");

    const culpritEvt = run.events.find((e) => e.type === "bisect.culprit");
    expect((culpritEvt?.data as any).culprit_task_id).toBe("T1");

    // R9.1: the task merges (no verify between merges); the one integration verify after it fails and
    // names the task, which is the whole change, so no prefix needs a verify of its own.
    const culpritIdx = run.events.indexOf(culpritEvt!);
    expect(run.events.slice(0, culpritIdx).filter((e) => e.type === "task.merged").length).toBe(1);

    // The base check, then the one integration verify on the merged run ref.
    const runHead = env.testRepo.git(["rev-parse", run.runRef]);
    expect(run.verifyRuns.map((r) => r.files)).toEqual([[], ["bad.ts"]]);
    expect(run.verifyRuns[1]?.ref).toBe(runHead);
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

    // R8.3: whichever task passes first merges, and the other one conflicts with it.
    const merged = run.events.filter((e) => e.type === "task.merged").map((e) => (e.data as any).task_id as string);
    expect(merged).toHaveLength(1);
    const winner = merged[0] as string;
    const loser = winner === "T1" ? "T2" : "T1";

    const conflictEvt = run.events.find((e) => e.type === "merge.conflict");
    expect((conflictEvt?.data as any).task_id).toBe(loser);
    expect((conflictEvt?.data as any).conflict_files).toEqual(["src/shared.ts"]);

    // (c) the conflicting task is dropped without a replan: failed for merge_conflict, and
    // the run goes on with the task that merged first (R8.1).
    const failed = run.events.find((e) => e.type === "task.failed" && (e.data as any).task_id === loser);
    expect((failed?.data as any).failure_class).toBe("merge_conflict");
    expect((failed?.data as any).can_replan).toBe(false);
    expect((failed?.data as any).detail).toContain(winner);
    const runSubjects = env.testRepo
      .git(["log", "--first-parent", "--reverse", "--format=%s", `${run.contractsSha}..${run.runRef}`])
      .split("\n");
    expect(runSubjects).toEqual([`merge: task ${winner}`]);

    // R9.1: the run ends at the conflict (the loser is blocked, so the plan never completes), before the
    // final gate: no integration verify runs at all.
    expect(run.verifyRuns).toEqual([]);

    // (d) the user's checkout keeps HEAD and the untracked file.
    expect(env.testRepo.git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(untrackedPath, "utf8")).toBe(untrackedContent);
  });
});
