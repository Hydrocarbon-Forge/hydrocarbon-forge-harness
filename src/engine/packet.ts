import fs from "node:fs";
import path from "node:path";

import {
  FailurePacket,
  type FailureClass,
  type RunId,
  type TaskId,
  type VerifyResult,
  type WorkerReport,
} from "../contracts/index.js";
import { gitCommitter } from "../git/index.js";

export interface BuildFailurePacketOptions {
  runId: RunId;
  taskId: TaskId;
  generation: number;
  failureClass: FailureClass;
  specPath: string;
  attempts: WorkerReport[];
  worktreePath: string;
  baseRef: string;
  packetDir: string;
  verifyOutput?: VerifyResult[];
  scopeViolations?: string[];
  workerSummary?: string;
  relatedContracts?: string[];
  dependents?: TaskId[];
  maxDiffBytes?: number;
}

export async function buildFailurePacket(
  opts: BuildFailurePacketOptions,
): Promise<FailurePacket> {
  // Ensure packetDir exists
  fs.mkdirSync(opts.packetDir, { recursive: true });

  // Generate diff
  const maxDiffBytes = opts.maxDiffBytes ?? 65536;
  let diffResult;
  try {
    diffResult = await gitCommitter.generateDiff(
      opts.worktreePath,
      opts.baseRef,
      maxDiffBytes,
    );
  } catch (err: any) {
    diffResult = {
      stat: "",
      patch: "",
      truncated: false,
    };
  }

  // Persist patch file
  const patchFileName = `${opts.taskId}-g${opts.generation}.patch`;
  const patchPath = path.join(opts.packetDir, patchFileName);
  fs.writeFileSync(patchPath, diffResult.patch, "utf8");

  // Sanitize worker summary: strip control chars, cap at 2048 chars
  const rawSummary =
    opts.workerSummary ??
    opts.attempts[opts.attempts.length - 1]?.final_message ??
    "";

  const sanitizedSummary = rawSummary
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r/g, "")
    .slice(0, 2048);

  const packet: FailurePacket = {
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    failure_class: opts.failureClass,
    spec_path: opts.specPath,
    attempts: opts.attempts,
    diff: {
      stat: diffResult.stat,
      patch_path: patchPath,
      truncated: diffResult.truncated,
    },
    verify_output: opts.verifyOutput ?? [],
    scope_violations: opts.scopeViolations ?? [],
    worker_summary: sanitizedSummary,
    related_contracts: opts.relatedContracts ?? [],
    dependents: opts.dependents ?? [],
  };

  // Validate against Zod schema
  const validated = FailurePacket.parse(packet);

  // Persist JSON file
  const jsonFileName = `${opts.taskId}-g${opts.generation}.json`;
  const jsonPath = path.join(opts.packetDir, jsonFileName);
  fs.writeFileSync(jsonPath, JSON.stringify(validated, null, 2), "utf8");

  return validated;
}
