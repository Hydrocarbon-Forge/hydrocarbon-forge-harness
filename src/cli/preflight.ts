import fs from "node:fs";
import path from "node:path";

import { ensureRepository, INITIALISED_NOTICE } from "../git/precondition.js";

export type PreflightCommand = "run" | "plan";
type RoleName = "planner" | "worker";

// The subset of parsed flags the preflight reads. Settings files never count as
// a named model: only a CLI flag or a request-payload field does.
export interface PreflightFlags {
  outputFormat?: "text" | "json" | "stream-json";
  mode?: string;
  model?: string;
  workerModel?: string;
  plan?: string;
  work?: string;
  request?: string;
}

export interface PreflightInput {
  cwd: string;
  flags: PreflightFlags;
  stdin?: string;
}

export type PreflightResult =
  | { ok: true; notice?: string }
  | { ok: false; message: string; hint?: string };

const FLAG_HINT: Record<RoleName, string> = {
  planner: "--plan <provider>:<model>",
  worker: "--work <provider>:<model>",
};

// `provider:model[:effort]`; a spec without a model part names no model.
function modelOf(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined;
  const model = spec.split(":")[1];
  return model && model.length > 0 ? model : undefined;
}

// The raw request payload, read without validation. Undefined when no request was
// given or it cannot be read as a JSON object (loadRequest reports those problems).
function readPayload(input: PreflightInput): Record<string, any> | undefined {
  if (input.flags.request === undefined) return undefined;
  let text: string;
  if (input.flags.request === "-") {
    text = input.stdin ?? "";
  } else {
    const file = path.isAbsolute(input.flags.request)
      ? input.flags.request
      : path.resolve(input.cwd, input.flags.request);
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The roles whose model the caller must name for this command. Run in auto or plan
 * mode needs both; run in solo needs the worker; plan needs the planner.
 */
export function requiredModelRoles(command: PreflightCommand, mode: string): RoleName[] {
  if (command === "plan") return ["planner"];
  return mode === "solo" ? ["worker"] : ["planner", "worker"];
}

/**
 * Roles whose model the caller named on the command line or in the request payload.
 * Mirrors how loadRequest applies --plan, --work, --model and --worker-model: a flag
 * that carries a model replaces the payload's model for that role.
 */
export function missingModelRoles(command: PreflightCommand, input: PreflightInput): RoleName[] {
  const payload = readPayload(input);
  const mode = command === "plan" ? "plan" : (input.flags.mode ?? payload?.mode ?? "auto");
  const modelFlagTarget: RoleName = mode === "solo" ? "worker" : "planner";
  const flags = input.flags;

  const named: Record<RoleName, boolean> = {
    planner:
      (flags.model !== undefined && modelFlagTarget === "planner") ||
      (flags.plan !== undefined ? modelOf(flags.plan) !== undefined : Boolean(payload?.planner?.model)),
    worker:
      (flags.model !== undefined && modelFlagTarget === "worker") ||
      flags.workerModel !== undefined ||
      (flags.work !== undefined ? modelOf(flags.work) !== undefined : Boolean(payload?.worker?.model)),
  };

  return requiredModelRoles(command, mode).filter((role) => !named[role]);
}

function modelMessage(command: PreflightCommand, mode: string, missing: RoleName[]): PreflightResult {
  const names = missing.join(" and ");
  const flags = missing.map((role) => FLAG_HINT[role]).join(" and ");
  const example =
    command === "plan"
      ? `substrate plan --plan claude:sonnet "<goal>"`
      : mode === "solo"
        ? `substrate run --mode solo --work claude:haiku "<goal>"`
        : `substrate run --plan claude:sonnet --work claude:haiku "<goal>"`;
  return {
    ok: false,
    message: `substrate ${command} needs an explicit ${names} model; settings files and defaults do not count`,
    hint: `name it with ${flags} (or ${missing.map((r) => `${r}.model`).join(" and ")} in the request file). Example: ${example}`,
  };
}

/**
 * Checks, in order, that the caller named the models this command needs and that the
 * project directory is a usable git repository. Both run before any run directory,
 * .substrate directory, git action or backend process exists.
 */
export function startPreflight(command: PreflightCommand, input: PreflightInput): PreflightResult {
  const mode = command === "plan" ? "plan" : (input.flags.mode ?? readPayload(input)?.mode ?? "auto");
  const missing = missingModelRoles(command, input);
  if (missing.length > 0) {
    return modelMessage(command, mode, missing);
  }

  // A request that cannot be read is left to loadRequest, which reports it as invalid_request.
  const repo = ensureRepository(input.cwd);
  if (!repo.ok) {
    return { ok: false, message: repo.message };
  }
  return repo.initialised ? { ok: true, notice: INITIALISED_NOTICE } : { ok: true };
}

/**
 * Writes a preflight refusal: text on stderr as `Error: ...`, json and stream-json as the
 * one-line {"error":...} object on stdout (the convention config errors use).
 */
export function reportPreflightError(
  input: { flags: PreflightFlags; stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream },
  result: { message: string; hint?: string },
): void {
  if (input.flags.outputFormat === "json" || input.flags.outputFormat === "stream-json") {
    const text = result.hint ? `${result.message}. ${result.hint}` : result.message;
    input.stdout.write(JSON.stringify({ error: text }) + "\n");
  } else {
    input.stderr.write(`Error: ${result.message}\n`);
    if (result.hint) input.stderr.write(`  ${result.hint}\n`);
  }
}

/** Writes the one notice line: stdout in text mode, stderr in json modes (stdout carries the JSON). */
export function writeNotice(input: { flags: PreflightFlags; stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream }, text: string): void {
  if (input.flags.outputFormat === "json" || input.flags.outputFormat === "stream-json") {
    input.stderr.write(text + "\n");
  } else {
    input.stdout.write(text + "\n");
  }
}
