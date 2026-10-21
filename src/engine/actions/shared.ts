import type {
  BackendName,
  EngineEvent,
  HarnessAdapter,
  Manifest,
  TaskId,
} from "../../contracts/index.js";
import type { EngineState } from "../reducer.js";
import type { EffectContext } from "../effects.js";
import type { TypedEmit } from "../emit.js";
import {
  parseManifest,
  parseTaskSpec,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../../spec/index.js";
import { resolveBaseRef } from "../../git/base-ref.js";
import { createIntegrationWorktree, verifyIn, type VerifyFailure } from "../../git/index.js";
import { withoutRootPaths } from "../../roles/planner.js";
import { withRepoLock } from "../../git/repo-lock.js";
import { redactSecrets, takeTail } from "../../util/index.js";

export type Emit = TypedEmit;

export { makeEmitter } from "../emit.js";

export function safeParseManifest(raw: string, filePath?: string): Manifest {
  return parseManifest(raw, filePath);
}

/**
 * The base check (R3.6 behaviour 8), run once per run before the first batch merge or the
 * final integration. It runs integration_verify on the base commit and records the result
 * in ctx.baseVerifyPassed. A failure does not stop the run: a run that adds new code is
 * expected to fail there, and the verify on the merged result decides the run.
 */
export async function checkBaseVerify(
  ctx: EffectContext,
  manifest: Manifest | undefined
): Promise<void> {
  const verifyCommands = manifest?.integration_verify ?? [];
  if (verifyCommands.length === 0 || ctx.baseChecked) return;
  ctx.baseChecked = true;
  const baseSha = resolveBaseRef(ctx.repoRoot, manifest?.base_ref).sha;
  const baseWt = await withRepoLock(ctx.repoRoot, () =>
    createIntegrationWorktree(ctx.repoRoot, ctx.runId, baseSha)
  );
  ctx.baseVerifyPassed = (await verifyIn(baseWt, verifyCommands, ctx.settings)).passed;
}

/** Longest command text an integration failure carries. */
export const INTEGRATION_COMMAND_MAX = 500;
/** Output an integration failure carries (the tail, after redaction). */
export const INTEGRATION_TAIL_MAX_BYTES = 2000;
/** Longest output line the failure message quotes. */
export const INTEGRATION_LINE_MAX = 200;

export interface IntegrationFailureDetail {
  command: string;
  exit_code: number | null;
  output_tail: string;
  /** `<command> exited <n>: <last output line>`, or `<command> timed out`. */
  message: string;
}

/**
 * What an integration failure says: the failing command, its exit code, a capped tail of its
 * output, and one message line for the run summary and the task event. Secrets are redacted and
 * the worktree and repository paths are taken out (withoutRootPaths), so the text reads the same
 * in any checkout.
 */
export function integrationFailureDetail(
  failure: VerifyFailure,
  roots: string[]
): IntegrationFailureDetail {
  const clean = (text: string): string => withoutRootPaths(redactSecrets(text), roots);
  const command = clean(failure.command).slice(0, INTEGRATION_COMMAND_MAX);
  const output_tail = takeTail(clean(failure.output), INTEGRATION_TAIL_MAX_BYTES).text;
  const lastLine =
    output_tail
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .pop() ?? "";
  const status = failure.timed_out ? "timed out" : `exited ${failure.exit_code}`;
  const quoted = lastLine === "" ? "" : `: ${lastLine.slice(0, INTEGRATION_LINE_MAX)}`;
  return {
    command,
    exit_code: failure.timed_out ? null : failure.exit_code,
    output_tail,
    message: `${command} ${status}${quoted}`,
  };
}

export { safeLoadPlan } from "../../spec/stub-plan.js";

export function adapterFor(
  ctx: EffectContext,
  backend: BackendName
): HarnessAdapter | null {
  const { adapters } = ctx;
  return (backend ? adapters[backend] : undefined) ?? null;
}

