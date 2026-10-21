import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { TaskMerger, verifyIn } from "../../git/merger.js";
import { gitIdentityEnv } from "../../git/identity.js";
import { setUpWorktree } from "../../git/setup.js";
import { loadSettings } from "../../config/index.js";
import { cleanIntegrationText, integrationFailureDetail, safeParseManifest } from "../../engine/actions/shared.js";
import { classifySetupFailure, classifyVerifyFailure } from "../../engine/verify-outcome.js";
import { spawnSync } from "node:child_process";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  run?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  dryRun?: boolean;
  abortOnConflict?: boolean;
  hard?: boolean;
  /** Land a failed run's passed tasks after its integration verify passes on the run branch (R8.2). */
  partial?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
}

export type ParsedCliFlags = CliGlobalFlags & CliGovernanceFlags;

export interface CommandContext {
  cwd: string;
  flags: ParsedCliFlags;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: Engine;
  sessionStore?: SessionStore;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

export interface MergeRunOptions {
  dryRun?: boolean;
  abortOnConflict?: boolean;
  /** Write nothing to stdout: the run command reports the landing itself (R7.4). */
  quiet?: boolean;
  /** Called with the conflicting files when the run cannot merge cleanly (R10.1). */
  onConflict?: (files: string[]) => void;
}

function resolveRunBranch(repoRoot: string, runId: string): { branch: string; exists: boolean } {
  let runBranch = `substrate/runs/${runId}`;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${runBranch}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return { branch: runBranch, exists: true };
  } catch {
    const doubleRef = `refs/heads/refs/heads/${runBranch}`;
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", doubleRef], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return { branch: doubleRef, exists: true };
    } catch {}
  }
  return { branch: runBranch, exists: false };
}

/** The run's events, or none when it has no event log. */
function runEventTypes(repoRoot: string, runId: string): Array<{ type: string; data?: any }> {
  const eventsFile = path.join(repoRoot, ".substrate", "runs", runId, "events.jsonl");
  if (!fs.existsSync(eventsFile)) return [];
  return fs
    .readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * `merge --partial` (R8.2): the run failed, and at least one of its tasks merged into the run
 * branch. Returns the reason it cannot land, or undefined when it can.
 */
function partialRefusal(repoRoot: string, runId: string): string | undefined {
  const events = runEventTypes(repoRoot, runId);
  const finished = events.filter((e) => e.type === "run.finished").at(-1);
  if (finished === undefined || finished.data?.exit_code === 0) {
    return `run ${runId} did not fail; use: substrate merge ${runId}`;
  }
  if (!events.some((e) => e.type === "task.merged")) {
    return `run ${runId} has no passed task on its run branch to land`;
  }
  return undefined;
}

/**
 * Runs the plan's setup and integration_verify on the run branch in a throwaway worktree (R8.2,
 * R12.2): the setup runs there first, as it does in the integration worktree. The worktree is
 * removed afterwards whatever the outcome.
 */
export type RunBranchVerdict =
  | { outcome: "passed" }
  | { outcome: "failed"; message: string }
  | { outcome: "not_run"; warning: string };

async function verifyRunBranch(
  ctx: CommandContext,
  runId: string,
  runBranch: string,
): Promise<RunBranchVerdict> {
  let commands: import("../../contracts/index.js").Command[] = [];
  let setup: import("../../contracts/index.js").Command[] = [];
  try {
    const manifest = safeParseManifest(fs.readFileSync(path.join(ctx.cwd, ".substrate", "runs", runId, "manifest.yaml"), "utf8"));
    commands = manifest.integration_verify ?? [];
    setup = manifest.setup ?? [];
  } catch {}
  const settings = await loadSettings({ projectDir: ctx.cwd, settingsFile: ctx.flags.settings });
  const worktree = path.join(ctx.cwd, ".substrate", "worktrees", runId, "partial-verify");
  execFileSync("git", ["worktree", "add", "--detach", worktree, runBranch], { cwd: ctx.cwd, stdio: "pipe" });
  try {
    const roots = [worktree, ctx.cwd];
    const prepared = await setUpWorktree(worktree, setup);
    // A setup or a check that cannot run is a warning, not a refusal (R12.2); a failed check refuses.
    if (prepared !== undefined && !prepared.passed) {
      const verdict = classifySetupFailure(prepared.failure);
      return { outcome: "not_run", warning: `${cleanIntegrationText(prepared.failure.command, roots)}: ${verdict.reason}` };
    }
    const outcome = await verifyIn(worktree, commands, settings);
    if (outcome.passed) return { outcome: "passed" };
    const detail = integrationFailureDetail(outcome.failure, roots);
    const verdict = classifyVerifyFailure(outcome.failure);
    if (verdict.verdict === "could_not_run") {
      return { outcome: "not_run", warning: `${detail.command}: ${verdict.reason}` };
    }
    return { outcome: "failed", message: detail.message };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: ctx.cwd, stdio: "pipe" });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

function isRunFinished(repoRoot: string, runId: string): boolean {
  const eventsFile = path.join(repoRoot, ".substrate", "runs", runId, "events.jsonl");
  if (!fs.existsSync(eventsFile)) {
    return false;
  }
  try {
    const content = fs.readFileSync(eventsFile, "utf8");
    const lines = content.split("\n");
    let finishedExitCode: number | null = null;
    let finishedIndex = -1;
    let lastPausedIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "run.finished") {
          finishedExitCode = typeof ev.data?.exit_code === "number" ? ev.data.exit_code : 0;
          finishedIndex = i;
        } else if (ev.type === "run.paused") {
          lastPausedIndex = i;
        }
      } catch {
        // ignore unparseable lines
      }
    }

    if (finishedIndex === -1 || finishedExitCode !== 0) {
      return false;
    }
    if (lastPausedIndex > finishedIndex) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function mergeRun(
  ctx: CommandContext,
  runId: string,
  opts?: MergeRunOptions
): Promise<number> {
  const dryRun = opts?.dryRun ?? !!ctx.flags.dryRun;
  const abortOnConflict = opts?.abortOnConflict ?? !!ctx.flags.abortOnConflict;

  const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
  const { branch: runBranch, exists: hasBranch } = resolveRunBranch(ctx.cwd, runId);
  const dirExists = fs.existsSync(runDir);

  if (!dirExists && !hasBranch) {
    ctx.stderr.write(`Error: unknown run ${runId}\n`);
    return 2;
  }

  const partial = ctx.flags.partial === true;
  if (partial) {
    const refusal = partialRefusal(ctx.cwd, runId);
    if (refusal !== undefined) {
      ctx.stderr.write(`Error: ${refusal}\n`);
      return 1;
    }
  } else if (!isRunFinished(ctx.cwd, runId)) {
    ctx.stderr.write(`Error: run ${runId} did not finish successfully; not merged\n`);
    return 1;
  }

  // Refuse if user's checkout has changes to tracked files
  try {
    const statusOut = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: ctx.cwd, encoding: "utf8" }
    ).trim();
    if (statusOut.length > 0) {
      ctx.stderr.write("Error: uncommitted changes to tracked files; commit or stash first\n");
      return 1;
    }
  } catch (err: any) {
    ctx.stderr.write(`Error checking git status: ${err.message}\n`);
    return 1;
  }

  let currentBranch = "";
  try {
    currentBranch = execFileSync(
      "git",
      ["branch", "--show-current"],
      { cwd: ctx.cwd, encoding: "utf8" }
    ).trim();
  } catch {}
  if (!currentBranch) {
    currentBranch = "HEAD";
  }

  // Already up to date?
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", runBranch, "HEAD"],
      { cwd: ctx.cwd, stdio: "ignore" }
    );
    if (opts?.quiet !== true) ctx.stdout.write("Already up to date.\n");
    return 0;
  } catch {}

  // R8.2: a partial landing lands only what passes integration verify on the run branch.
  if (partial) {
    const verified = await verifyRunBranch(ctx, runId, runBranch);
    if (verified.outcome === "failed") {
      ctx.stderr.write(`not merged: integration verify failed on the run branch: ${verified.message}\n`);
      return 1;
    }
    if (verified.outcome === "not_run") {
      ctx.stderr.write(`warning: integration verify could not run (${verified.warning}); the work is merged but was not verified as a whole\n`);
    }
  }

  // Conflict preflight
  const merger = new TaskMerger();
  const pf = await merger.preflight(ctx.cwd, "HEAD", runBranch);
  if (!pf.clean) {
    if (!abortOnConflict) {
      opts?.onConflict?.(pf.conflictFiles ?? []);
      if (opts?.quiet !== true) {
        for (const file of pf.conflictFiles ?? []) {
          ctx.stderr.write(`${file}\n`);
        }
      }
      return 1;
    }

    try {
      execFileSync(
        "git",
        ["merge", "--no-ff", "-m", `merge run ${runId}`, runBranch],
        { cwd: ctx.cwd, encoding: "utf8", stdio: "pipe", env: gitIdentityEnv(ctx.cwd) }
      );
    } catch {
      try {
        execFileSync("git", ["merge", "--abort"], {
          cwd: ctx.cwd,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch {}
      return 1;
    }
  }

  if (dryRun) {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `HEAD..${runBranch}`],
      { cwd: ctx.cwd, encoding: "utf8" }
    ).trim();
    ctx.stdout.write(`would merge ${count} commit(s) from ${runBranch} into ${currentBranch}\n`);
    return 0;
  }

  try {
    execFileSync(
      "git",
      ["merge", "--no-ff", "-m", `merge run ${runId}`, runBranch],
      { cwd: ctx.cwd, encoding: "utf8", stdio: "pipe", env: gitIdentityEnv(ctx.cwd) }
    );
    if (opts?.quiet !== true) ctx.stdout.write(`Merged ${runBranch} into ${currentBranch}\n`);
    return 0;
  } catch (err: any) {
    ctx.stderr.write(`Error merging ${runBranch}: ${err.message}\n`);
    return 1;
  }
}

const { registry } = await import(`../registry.js`);

export const mergeCommand: CliCommand = {
  name: "merge",
  description: "Merge finished run branch into current branch",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0] || ctx.flags.run;
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }
    return mergeRun(ctx, runId);
  },
};

registry.register(mergeCommand);
