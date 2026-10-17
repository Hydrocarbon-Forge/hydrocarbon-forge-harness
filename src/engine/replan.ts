import fs from "node:fs";
import path from "node:path";

import type {
  Diagnostic,
  EngineEvent,
  HarnessAdapter,
  PauseReason,
  Route,
  RunId,
  Settings,
  SpawnRequest,
  TaskId,
} from "../contracts/index.js";
import type { FailurePacket } from "../contracts/index.js";
import {
  loadPlan,
  parseTaskSpec,
  typecheckContracts,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../spec/index.js";
import { evaluateEscalation, type EscalationAction } from "./ladder.js";
import type { EngineState } from "./reducer.js";
import { buildReplanPrompt } from "../roles/prompts/replan.js";
import { resolveTaskRoute } from "../roles/router.js";
import { commitContractStubs } from "../roles/planner.js";

export interface ReplanExecutionOptions {
  runId: RunId;
  taskId: TaskId;
  packet: FailurePacket;
  state: EngineState;
  settings: Settings;
  adapter: HarnessAdapter;
  runDir: string;
  repoRoot: string;
  baseRef: string;
  decisionsLog?: string;
  onEvent?: (event: EngineEvent) => void;
}

export interface ReplanResult {
  level: "L0" | "L1" | "L2" | "L3";
  status: "replan_ready" | "paused" | "healed";
  action: EscalationAction;
  revisedSpec?: ParsedTaskSpec;
  revisedPlan?: ParsedPlan;
  packet: FailurePacket;
  diagnostics?: Diagnostic[];
  pauseReason?: PauseReason;
}

export function resolveEscalationRoute(
  taskClass: string,
  generation: number,
  settings: Settings,
): Route {
  return resolveTaskRoute(taskClass as any, generation, settings);
}

export async function executeReplan(
  opts: ReplanExecutionOptions,
): Promise<ReplanResult> {
  // Invariant: permission_denied and rate_limited never trigger replanning
  if (opts.packet.failure_class === "permission_denied") {
    opts.onEvent?.({
      type: "run.paused",
      run_id: opts.runId,
      reason: "permission_denied",
    } as any);

    return {
      level: "L3",
      status: "paused",
      action: {
        level: "L3",
        action: "pause",
        reason: "permission_denied",
      },
      packet: opts.packet,
      pauseReason: "permission_denied",
    };
  }

  if (opts.packet.failure_class === "rate_limited") {
    opts.onEvent?.({
      type: "run.paused",
      run_id: opts.runId,
      reason: "rate_limited",
    } as any);

    return {
      level: "L3",
      status: "paused",
      action: {
        level: "L3",
        action: "pause",
        reason: "rate_limited",
      },
      packet: opts.packet,
      pauseReason: "rate_limited",
    };
  }

  const action = evaluateEscalation(
    opts.state,
    opts.taskId,
    opts.packet.failure_class,
    opts.settings,
  );

  if (action.level === "L0") {
    return {
      level: "L0",
      status: "healed",
      action,
      packet: opts.packet,
    };
  }

  if (action.level === "L1") {
    opts.onEvent?.({
      type: "replan.started",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.packet.generation,
      next_generation: action.generation,
      target_tier: action.route.model,
    } as any);

    const promptData = buildReplanPrompt(opts.packet, opts.decisionsLog);

    const spawnReq: SpawnRequest = {
      role: "planner",
      cwd: opts.runDir,
      prompt: promptData.user,
      system_append: promptData.system,
      model: action.route.model,
      effort: action.route.effort,
      permission: {
        allow: [opts.runDir],
        deny: [
          "git commit",
          "git push",
          "git checkout",
          "git reset",
          "subagents",
        ],
      },
      budget: {
        max_usd: opts.settings.budgets?.task?.max_usd ?? 5.0,
        timeout_ms:
          (opts.settings.budgets?.task?.timeout_min ?? 30) * 60 * 1000,
        ...(opts.settings.budgets?.task?.max_tokens
          ? { max_tokens: opts.settings.budgets.task.max_tokens }
          : {}),
      },
    };

    const handle = opts.adapter.spawn(spawnReq);
    for await (const evt of handle.events) {
      opts.onEvent?.(evt as any);
    }
    await handle.result();

    // Collect revised spec
    let specPath = path.join(opts.runDir, "tasks", `${opts.taskId}.md`);
    if (!fs.existsSync(specPath) && opts.packet.spec_path && fs.existsSync(opts.packet.spec_path)) {
      specPath = opts.packet.spec_path;
    }

    let revisedSpec: ParsedTaskSpec | undefined;
    if (fs.existsSync(specPath)) {
      const raw = fs.readFileSync(specPath, "utf8");
      revisedSpec = parseTaskSpec(raw, specPath);
    }

    opts.onEvent?.({
      type: "replan.finished",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: action.generation,
    } as any);

    return {
      level: "L1",
      status: "replan_ready",
      action,
      revisedSpec,
      packet: opts.packet,
    };
  }

  if (action.level === "L2") {
    const promptData = buildReplanPrompt(opts.packet, opts.decisionsLog);
    promptData.user += "\n\nAmend contracts and manifest to resolve contract defect.";

    const spawnReq: SpawnRequest = {
      role: "planner",
      cwd: opts.runDir,
      prompt: promptData.user,
      system_append: promptData.system,
      model: opts.settings.roles.planner.model,
      effort: opts.settings.roles.planner.effort,
      permission: {
        allow: [opts.runDir],
        deny: [
          "git commit",
          "git push",
          "git checkout",
          "git reset",
          "subagents",
        ],
      },
      budget: {
        max_usd: opts.settings.budgets?.task?.max_usd ?? 5.0,
        timeout_ms:
          (opts.settings.budgets?.task?.timeout_min ?? 30) * 60 * 1000,
      },
    };

    const handle = opts.adapter.spawn(spawnReq);
    for await (const evt of handle.events) {
      opts.onEvent?.(evt as any);
    }
    await handle.result();

    const manifestPath = path.join(opts.runDir, "manifest.yaml");
    let revisedPlan: ParsedPlan | undefined;
    if (fs.existsSync(manifestPath)) {
      try {
        revisedPlan = await loadPlan(manifestPath);
      } catch {}
    }

    if (revisedPlan?.manifest.contracts) {
      try {
        await typecheckContracts(
          opts.runDir,
          revisedPlan.manifest.contracts,
          { cwd: opts.runDir },
        );
      } catch {}

      try {
        await commitContractStubs(
          opts.repoRoot,
          opts.runId,
          opts.baseRef,
          revisedPlan.manifest.contracts,
          opts.runDir,
        );
      } catch {}
    }

    return {
      level: "L2",
      status: "replan_ready",
      action,
      revisedPlan,
      packet: opts.packet,
    };
  }

  // Level L3: Pause run
  opts.onEvent?.({
    type: "run.paused",
    run_id: opts.runId,
    reason: action.reason,
  } as any);

  return {
    level: "L3",
    status: "paused",
    action,
    pauseReason: action.reason,
    packet: opts.packet,
  };
}
