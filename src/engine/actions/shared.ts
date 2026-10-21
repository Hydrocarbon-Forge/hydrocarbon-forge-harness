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
import type { VerifyFailure } from "../../git/index.js";
import { withoutRootPaths } from "../../roles/planner.js";
import { redactSecrets, takeTail } from "../../util/index.js";

export type Emit = TypedEmit;

export { makeEmitter } from "../emit.js";

export function safeParseManifest(raw: string, filePath?: string): Manifest {
  return parseManifest(raw, filePath);
}

/** Longest command text an integration failure carries. */
export const INTEGRATION_COMMAND_MAX = 500;
/** Output an integration failure carries (the tail, after redaction). */
export const INTEGRATION_TAIL_MAX_BYTES = 2000;

export interface IntegrationFailureDetail {
  command: string;
  exit_code: number | null;
  output_tail: string;
  /** `<command> exited <n>`, or `<command> timed out`; the output itself is in output_tail (R12.2). */
  message: string;
}

/**
 * What an integration failure says: the failing command, its exit code, a capped tail of its
 * output, and one message line for the run summary and the task event. Secrets are redacted and
 * the worktree and repository paths are taken out (withoutRootPaths), so the text reads the same
 * in any checkout.
 */
/** Redacts secrets and takes the worktree and repository paths out, so a check's text reads the same in any checkout. */
export function cleanIntegrationText(text: string, roots: string[]): string {
  return withoutRootPaths(redactSecrets(text), roots);
}

export function integrationFailureDetail(
  failure: VerifyFailure,
  roots: string[]
): IntegrationFailureDetail {
  const clean = (text: string): string => cleanIntegrationText(text, roots);
  const command = clean(failure.command).slice(0, INTEGRATION_COMMAND_MAX);
  const output_tail = takeTail(clean(failure.output), INTEGRATION_TAIL_MAX_BYTES).text;
  const status = failure.timed_out ? "timed out" : `exited ${failure.exit_code}`;
  return {
    command,
    exit_code: failure.timed_out ? null : failure.exit_code,
    output_tail,
    message: `${command} ${status}`,
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

