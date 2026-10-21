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

export type Emit = TypedEmit;

export { makeEmitter } from "../emit.js";

export function safeParseManifest(raw: string, filePath?: string): Manifest {
  return parseManifest(raw, filePath);
}

export { safeLoadPlan } from "../../spec/stub-plan.js";

export function adapterFor(
  ctx: EffectContext,
  backend: BackendName
): HarnessAdapter | null {
  const { adapters } = ctx;
  return (backend ? adapters[backend] : undefined) ?? null;
}

