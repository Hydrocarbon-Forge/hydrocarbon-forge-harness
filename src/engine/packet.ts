import fs from "node:fs";
import path from "node:path";

import {
  FailurePacket,
  WorkerReport,
  type FailureClass,
  type RunId,
  type TaskId,
  type VerifyResult,
} from "../contracts/index.js";
import { gitCommitter } from "../git/index.js";

export interface BuildFailurePacketOptions {
  runId: RunId;
  taskId: TaskId;
  generation: number;
  failureClass: FailureClass;
  specPath: string;
  /**
   * WorkerReports for the failed generation. When not supplied they are read back from
   * the per-attempt files the worker action wrote in the same packet directory
   * (R3.5 rule 2), so the packet is built from what was recorded, not from memory.
   */
  attempts?: WorkerReport[];
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

/**
 * Per-attempt report files: `<packetDir>/<task>-g<n>-attempt<k>.json`, in attempt order.
 */
function attemptReports(packetDir: string, taskId: TaskId, generation: number): WorkerReport[] {
  const prefix = `${taskId}-g${generation}-attempt`;
  let names: string[];
  try {
    names = fs.readdirSync(packetDir);
  } catch {
    return [];
  }

  const files = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort((a, b) => attemptNumber(a) - attemptNumber(b));

  const reports: WorkerReport[] = [];
  for (const name of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(packetDir, name), "utf8"));
      reports.push(WorkerReport.parse(raw));
    } catch {
      // A report file that does not parse is not a recorded attempt: skip it.
    }
  }
  return reports;
}

function attemptNumber(name: string): number {
  const match = name.match(/-attempt(\d+)\.json$/);
  return match ? Number(match[1]) : 0;
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

  const attempts = opts.attempts ?? attemptReports(opts.packetDir, opts.taskId, opts.generation);
  const lastAttempt = attempts[attempts.length - 1];

  // Sanitize worker summary: strip control chars, cap at 2048 chars
  const rawSummary = opts.workerSummary ?? lastAttempt?.final_message ?? "";

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
    attempts,
    diff: {
      stat: diffResult.stat,
      patch_path: patchPath,
      truncated: diffResult.truncated,
    },
    verify_output: opts.verifyOutput ?? lastAttempt?.verify ?? [],
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
