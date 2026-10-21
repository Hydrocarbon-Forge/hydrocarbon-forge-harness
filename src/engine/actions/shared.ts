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
import { createIntegrationWorktree, verifyIn } from "../../git/index.js";

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
  const baseWt = await createIntegrationWorktree(ctx.repoRoot, ctx.runId, baseSha);
  ctx.baseVerifyPassed = await verifyIn(baseWt, verifyCommands, ctx.settings);
}

export { safeLoadPlan } from "../../spec/stub-plan.js";

export function adapterFor(
  ctx: EffectContext,
  backend: BackendName
): HarnessAdapter | null {
  const { adapters } = ctx;
  return (backend ? adapters[backend] : undefined) ?? null;
}

