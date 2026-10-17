import fs from "node:fs";
import path from "node:path";

import type {
  Command,
  EngineEvent,
  FailureClass,
  HarnessAdapter,
  RunId,
  Settings,
  SpawnRequest,
  TaskId,
  TaskSpecFrontmatter,
  UsageRecord,
  VerifyResult,
  WorkerReport,
} from "../contracts/index.js";
import {
  workspaceManager,
  workspaceLifecycle,
  scopeEnforcer,
  gitCommitter,
} from "../git/index.js";
import { VerifyRunner } from "../verify/index.js";
import { buildWorkerPrompt } from "./prompts/worker.js";
import { resolveTaskRoute } from "./router.js";

export interface WorkerRunOptions {
  runId: RunId;
  taskId: TaskId;
  spec: TaskSpecFrontmatter;
  specContent: string;
  specAbsPath: string;
  generation: number;
  repoRoot: string;
  settings: Settings;
  adapter: HarnessAdapter;
  baseRef: string;
  setupCommands?: Command[];
  onEvent?: (event: EngineEvent) => void;
}

export async function runWorker(
  opts: WorkerRunOptions,
): Promise<WorkerReport> {
  const route = resolveTaskRoute(
    opts.spec.class as any,
    opts.generation,
    opts.settings,
  );

  let cumulativeUsage: UsageRecord = {
    backend: route.backend,
    model: route.model,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_source: "computed",
    at: new Date().toISOString(),
  };

  const startTime = Date.now();

  // Step 1: Worktree Setup
  const worktreeInfo = await workspaceManager.createTaskWorktree(
    opts.repoRoot,
    opts.runId,
    opts.spec,
    opts.generation,
    opts.baseRef,
  );

  opts.onEvent?.({
    type: "task.worktree.created",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    worktree_path: worktreeInfo.worktreePath,
  } as any);

  // Materialize spec at .substrate-task/spec.md and .substrate-task/TASK.md
  await workspaceManager.materializeSpec(
    worktreeInfo.worktreePath,
    opts.specContent,
  );
  try {
    const specMdPath = path.join(
      worktreeInfo.worktreePath,
      ".substrate-task",
      "spec.md",
    );
    fs.writeFileSync(specMdPath, opts.specContent, "utf8");
  } catch {}

  // Run setup commands if provided
  if (opts.setupCommands && opts.setupCommands.length > 0) {
    try {
      await workspaceLifecycle.runSetup(
        worktreeInfo.worktreePath,
        opts.setupCommands,
      );
    } catch (err: any) {
      await workspaceLifecycle.removeWorktree(
        opts.repoRoot,
        worktreeInfo.worktreePath,
      );
      opts.onEvent?.({
        type: "task.failed",
        run_id: opts.runId,
        task_id: opts.taskId,
        generation: opts.generation,
        failure_class: "worker_crashed",
      } as any);

      return {
        task_id: opts.taskId,
        generation: opts.generation,
        attempt: 1,
        session_id: "setup",
        backend: route.backend,
        model: route.model,
        ...(route.effort ? { effort: route.effort } : {}),
        status: "failed",
        failure_class: "worker_crashed",
        files_changed: [],
        usage: cumulativeUsage,
        duration_ms: Date.now() - startTime,
        verify: [],
        denials: [],
        final_message: `Setup command failed: ${err.message}`,
      };
    }
  }

  // Hash protected files
  const initialHashes = await scopeEnforcer.hashProtectedFiles(
    worktreeInfo.worktreePath,
    opts.spec.protected ?? [],
  );

  // Step 2: Attempt 1 Spawning
  let attempt = 1;
  const promptData = buildWorkerPrompt(opts.specAbsPath);

  const spawnReq: SpawnRequest = {
    role: "worker",
    cwd: worktreeInfo.worktreePath,
    prompt: promptData.user,
    system_append: promptData.system,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    permission: {
      allow: [worktreeInfo.worktreePath],
      deny: [
        "git commit",
        "git push",
        "git checkout",
        "git reset",
        "subagents",
      ],
    },
    budget: {
      max_usd:
        opts.spec.budget?.max_usd ??
        opts.settings.budgets?.task?.max_usd ??
        5.0,
      timeout_ms:
        (opts.spec.budget?.timeout_min ??
          opts.settings.budgets?.task?.timeout_min ??
          30) *
        60 *
        1000,
      ...(opts.spec.budget?.max_tokens
        ? { max_tokens: opts.spec.budget.max_tokens }
        : {}),
    },
  };

  opts.onEvent?.({
    type: "task.session.started",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 1,
  } as any);

  let sessionHandle = opts.adapter.spawn(spawnReq);
  let sessionId = `worker-${opts.taskId}-g${opts.generation}-a1`;

  for await (const evt of sessionHandle.events) {
    opts.onEvent?.(evt as any);
    if (evt.type === "session.started" && (evt as any).session_id) {
      sessionId = (evt as any).session_id;
    }
    if (evt.type === "usage" && (evt as any).record) {
      const u = (evt as any).record as UsageRecord;
      cumulativeUsage = {
        ...cumulativeUsage,
        input_tokens: cumulativeUsage.input_tokens + (u.input_tokens ?? 0),
        output_tokens: cumulativeUsage.output_tokens + (u.output_tokens ?? 0),
        cost_usd: (cumulativeUsage.cost_usd ?? 0) + (u.cost_usd ?? 0),
      };
    }
  }

  let sessionRes = await sessionHandle.result();
  if (sessionRes?.session_id) {
    sessionId = sessionRes.session_id;
  }
  if (sessionRes?.usage) {
    cumulativeUsage = {
      ...cumulativeUsage,
      input_tokens: Math.max(cumulativeUsage.input_tokens, sessionRes.usage.input_tokens ?? 0),
      output_tokens: Math.max(cumulativeUsage.output_tokens, sessionRes.usage.output_tokens ?? 0),
      cost_usd: Math.max(cumulativeUsage.cost_usd ?? 0, sessionRes.usage.cost_usd ?? 0),
    };
  }

  opts.onEvent?.({
    type: "task.session.ended",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 1,
    exit_code: sessionRes.exit_code,
    duration_ms: Date.now() - startTime,
  } as any);

  // Check if session crashed or timed out
  if (!sessionRes.ok || (sessionRes.exit_code !== null && sessionRes.exit_code !== 0)) {
    let failureClass: FailureClass = "worker_crashed";
    if (sessionRes.killed_for === "timeout" || sessionRes.exit_code === 137) {
      failureClass = "timeout";
    } else if (sessionRes.killed_for === "budget") {
      failureClass = "budget_exceeded";
    }

    opts.onEvent?.({
      type: "task.failed",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.generation,
      failure_class: failureClass,
    } as any);

    return {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 1,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
      ...(route.effort ? { effort: route.effort } : {}),
      status: "failed",
      failure_class: failureClass,
      files_changed: [],
      usage: cumulativeUsage,
      duration_ms: Date.now() - startTime,
      verify: [],
      denials: (sessionRes.denials ?? []).map((d) => d.tool),
      final_message: sessionRes.final_text || `Session failed with exit code ${sessionRes.exit_code}`,
    };
  }

  // Step 3: Scope and Protected Files Check
  let scopeRes = await scopeEnforcer.checkScope(
    worktreeInfo.worktreePath,
    opts.spec,
    initialHashes,
    opts.settings.git.on_scope_violation,
  );

  opts.onEvent?.({
    type: "task.scope.checked",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 1,
    ok: scopeRes.ok,
    violations: scopeRes.violations,
    protected_modified: scopeRes.protectedModified,
  } as any);

  // Invariant: Protected modified skips healing, immediately fails
  if (scopeRes.protectedModified.length > 0) {
    opts.onEvent?.({
      type: "task.failed",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.generation,
      failure_class: "protected_modified",
    } as any);

    return {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 1,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
      ...(route.effort ? { effort: route.effort } : {}),
      status: "failed",
      failure_class: "protected_modified",
      files_changed: scopeRes.allowedChanges,
      usage: cumulativeUsage,
      duration_ms: Date.now() - startTime,
      verify: [],
      denials: (sessionRes.denials ?? []).map((d) => d.tool),
      final_message: sessionRes.final_text,
    };
  }

  if (scopeRes.violations.length > 0 && opts.settings.git.on_scope_violation === "fail") {
    opts.onEvent?.({
      type: "task.failed",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.generation,
      failure_class: "scope_violation",
    } as any);

    return {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 1,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
      ...(route.effort ? { effort: route.effort } : {}),
      status: "failed",
      failure_class: "scope_violation",
      files_changed: scopeRes.allowedChanges,
      usage: cumulativeUsage,
      duration_ms: Date.now() - startTime,
      verify: [],
      denials: (sessionRes.denials ?? []).map((d) => d.tool),
      final_message: sessionRes.final_text,
    };
  }

  // Step 4: Acceptance Verification & L0 Healing
  const verifyRunner = new VerifyRunner();

  opts.onEvent?.({
    type: "task.verify.started",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 1,
  } as any);

  let verifyResults = await verifyRunner.runVerify({
    cwd: worktreeInfo.worktreePath,
    commands: opts.spec.verify ?? [],
    sandbox: opts.settings.sandbox.enabled,
    network: "deny",
  });

  opts.onEvent?.({
    type: "task.verify.finished",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 1,
    passed: verifyRunner.isAllPassed(verifyResults),
  } as any);

  if (verifyRunner.isAllPassed(verifyResults)) {
    // Commit allowed changes
    try {
      await gitCommitter.commitAllowed(
        worktreeInfo.worktreePath,
        opts.spec,
        `feat(task): ${opts.taskId}`,
      );
    } catch {}

    opts.onEvent?.({
      type: "task.passed",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 1,
    } as any);

    return {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 1,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
      ...(route.effort ? { effort: route.effort } : {}),
      status: "passed",
      files_changed: scopeRes.allowedChanges,
      usage: cumulativeUsage,
      duration_ms: Date.now() - startTime,
      verify: verifyResults,
      denials: (sessionRes.denials ?? []).map((d) => d.tool),
      final_message: sessionRes.final_text,
    };
  }

  // First verification failed: attempt L0 Healing
  attempt = 2;
  opts.onEvent?.({
    type: "task.healing",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    session_id: sessionId,
  } as any);

  const failingCmds = verifyResults.filter((r) => r.exit_code !== 0 || r.timed_out);
  const failureTails = failingCmds
    .map((f) => {
      const parts = [`Command: ${f.cmd}`, `Exit code: ${f.exit_code}`];
      if (f.stdout_tail) parts.push(`Stdout:\n${f.stdout_tail.slice(0, 8192)}`);
      if (f.stderr_tail) parts.push(`Stderr:\n${f.stderr_tail.slice(0, 8192)}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const healPrompt = `Fix only what these checks indicate. Do not change scope or tests.\n\n${failureTails}`;

  opts.onEvent?.({
    type: "task.session.started",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 2,
  } as any);

  const healSpawnReq: SpawnRequest = {
    ...spawnReq,
    prompt: healPrompt,
    session: {
      resume: sessionId,
    },
  };

  sessionHandle = opts.adapter.spawn(healSpawnReq);

  for await (const evt of sessionHandle.events) {
    opts.onEvent?.(evt as any);
    if (evt.type === "usage" && (evt as any).record) {
      const u = (evt as any).record as UsageRecord;
      cumulativeUsage = {
        ...cumulativeUsage,
        input_tokens: cumulativeUsage.input_tokens + (u.input_tokens ?? 0),
        output_tokens: cumulativeUsage.output_tokens + (u.output_tokens ?? 0),
        cost_usd: (cumulativeUsage.cost_usd ?? 0) + (u.cost_usd ?? 0),
      };
    }
  }

  sessionRes = await sessionHandle.result();
  if (sessionRes?.usage) {
    cumulativeUsage = {
      ...cumulativeUsage,
      input_tokens: Math.max(cumulativeUsage.input_tokens, sessionRes.usage.input_tokens ?? 0),
      output_tokens: Math.max(cumulativeUsage.output_tokens, sessionRes.usage.output_tokens ?? 0),
      cost_usd: Math.max(cumulativeUsage.cost_usd ?? 0, sessionRes.usage.cost_usd ?? 0),
    };
  }

  opts.onEvent?.({
    type: "task.session.ended",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 2,
    exit_code: sessionRes.exit_code,
    duration_ms: Date.now() - startTime,
  } as any);

  // Scope check after attempt 2
  scopeRes = await scopeEnforcer.checkScope(
    worktreeInfo.worktreePath,
    opts.spec,
    initialHashes,
    opts.settings.git.on_scope_violation,
  );

  opts.onEvent?.({
    type: "task.scope.checked",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 2,
    ok: scopeRes.ok,
    violations: scopeRes.violations,
    protected_modified: scopeRes.protectedModified,
  } as any);

  if (scopeRes.protectedModified.length > 0) {
    opts.onEvent?.({
      type: "task.failed",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.generation,
      failure_class: "protected_modified",
    } as any);

    return {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 2,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
      ...(route.effort ? { effort: route.effort } : {}),
      status: "failed",
      failure_class: "protected_modified",
      files_changed: scopeRes.allowedChanges,
      usage: cumulativeUsage,
      duration_ms: Date.now() - startTime,
      verify: verifyResults,
      denials: (sessionRes.denials ?? []).map((d) => d.tool),
      final_message: sessionRes.final_text,
    };
  }

  if (scopeRes.violations.length > 0 && opts.settings.git.on_scope_violation === "fail") {
    opts.onEvent?.({
      type: "task.failed",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.generation,
      failure_class: "scope_violation",
    } as any);

    return {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 2,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
      ...(route.effort ? { effort: route.effort } : {}),
      status: "failed",
      failure_class: "scope_violation",
      files_changed: scopeRes.allowedChanges,
      usage: cumulativeUsage,
      duration_ms: Date.now() - startTime,
      verify: verifyResults,
      denials: (sessionRes.denials ?? []).map((d) => d.tool),
      final_message: sessionRes.final_text,
    };
  }

  // Verification check after attempt 2
  opts.onEvent?.({
    type: "task.verify.started",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 2,
  } as any);

  verifyResults = await verifyRunner.runVerify({
    cwd: worktreeInfo.worktreePath,
    commands: opts.spec.verify ?? [],
    sandbox: opts.settings.sandbox.enabled,
    network: "deny",
  });

  const passedAttempt2 = verifyRunner.isAllPassed(verifyResults);

  opts.onEvent?.({
    type: "task.verify.finished",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 2,
    passed: passedAttempt2,
  } as any);

  if (passedAttempt2) {
    try {
      await gitCommitter.commitAllowed(
        worktreeInfo.worktreePath,
        opts.spec,
        `feat(task): ${opts.taskId}`,
      );
    } catch {}

    opts.onEvent?.({
      type: "task.passed",
      run_id: opts.runId,
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 2,
    } as any);

    return {
      task_id: opts.taskId,
      generation: opts.generation,
      attempt: 2,
      session_id: sessionId,
      backend: route.backend,
      model: route.model,
      ...(route.effort ? { effort: route.effort } : {}),
      status: "passed",
      files_changed: scopeRes.allowedChanges,
      usage: cumulativeUsage,
      duration_ms: Date.now() - startTime,
      verify: verifyResults,
      denials: (sessionRes.denials ?? []).map((d) => d.tool),
      final_message: sessionRes.final_text,
    };
  }

  // Attempt 2 also failed
  opts.onEvent?.({
    type: "task.failed",
    run_id: opts.runId,
    task_id: opts.taskId,
    generation: opts.generation,
    failure_class: "verify_failed",
  } as any);

  return {
    task_id: opts.taskId,
    generation: opts.generation,
    attempt: 2,
    session_id: sessionId,
    backend: route.backend,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    status: "failed",
    failure_class: "verify_failed",
    files_changed: scopeRes.allowedChanges,
    usage: cumulativeUsage,
    duration_ms: Date.now() - startTime,
    verify: verifyResults,
    denials: (sessionRes.denials ?? []).map((d) => d.tool),
    final_message: sessionRes.final_text,
  };
}
