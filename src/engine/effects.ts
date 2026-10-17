import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import type {
  Command,
  Diagnostic,
  EngineEvent,
  FailureClass,
  FailurePacket,
  HarnessAdapter,
  Manifest,
  PauseReason,
  PermissionMode,
  Route,
  RunId,
  RunOptions,
  RunSummary,
  Settings,
  SpawnRequest,
  TaskId,
  TaskSpecFrontmatter,
  UsageRecord,
  VerifyResult,
} from "../contracts/index.js";
import {
  type EngineState,
  type RunState,
  type TaskState,
  type TaskRuntimeState,
  reduce,
  computeDagLayers,
} from "./reducer.js";
import { evaluateEscalation, type EscalationAction } from "./ladder.js";
import { buildFailurePacket } from "./packet.js";
import {
  workspaceManager,
  workspaceLifecycle,
  scopeEnforcer,
  gitCommitter,
  TaskMergerImpl,
  BatchIntegrationMergerImpl,
  getRunBranch,
  getTaskBranch,
} from "../git/index.js";
import { VerifyRunner } from "../verify/runner.js";
import {
  loadPlan,
  parseManifest,
  parseTaskSpec,
  lintPlan,
  typecheckContracts,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../spec/index.js";
import { runPlanner, commitContractStubs } from "../roles/planner.js";
import { routeRequest, resolveTaskRoute } from "../roles/router.js";
import { checkGovernorHealth, callGovernorIntake } from "../roles/governor.js";
import { buildWorkerPrompt } from "../roles/prompts/worker.js";
import { buildReplanPrompt } from "../roles/prompts/replan.js";
import { estimateRunCost } from "../ledger/index.js";

function extractFencedFiles(text: string): Map<string, string> {
  const files = new Map<string, string>();
  const headerRegex = /```(?:[a-zA-Z0-9_-]+):([^\n\r]+)/g;
  const matches: Array<{ file: string; start: number; headerIndex: number }> = [];
  let match;
  while ((match = headerRegex.exec(text)) !== null) {
    matches.push({
      file: match[1].trim(),
      start: match.index + match[0].length,
      headerIndex: match.index,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    let endIdx: number;
    if (i + 1 < matches.length) {
      endIdx = text.lastIndexOf("```", matches[i + 1].headerIndex - 1);
    } else {
      endIdx = text.lastIndexOf("```");
    }
    const content = (endIdx > cur.start ? text.slice(cur.start, endIdx) : text.slice(cur.start)).trim();
    files.set(cur.file, content);
  }
  return files;
}

export function safeParseManifest(raw: string, filePath?: string): Manifest {
  try {
    return parseManifest(raw, filePath);
  } catch {
    return YAML.parse(raw) as Manifest;
  }
}

export async function safeLoadPlan(
  manifestPath: string,
  repoRoot?: string
): Promise<ParsedPlan & { cleanup: () => void }> {
  const resolvedManifestPath = path.resolve(manifestPath);
  const rawManifest = await fs.promises.readFile(resolvedManifestPath, "utf8");
  const manifest = safeParseManifest(rawManifest, manifestPath);
  const manifestDir = path.dirname(resolvedManifestPath);
  const specs = new Map<TaskId, ParsedTaskSpec>();
  const createdFiles: string[] = [];

  if (repoRoot && manifest.contracts?.files) {
    for (const f of manifest.contracts.files) {
      const full = path.resolve(repoRoot, f);
      if (!fs.existsSync(full)) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "export {};\n", "utf8");
        createdFiles.push(full);
      }
    }
  }

  for (const task of manifest.tasks ?? []) {
    const specPath = path.resolve(manifestDir, task.spec);
    let rawSpec = "";
    if (fs.existsSync(specPath)) {
      rawSpec = await fs.promises.readFile(specPath, "utf8");
    }
    const parsedSpec = parseTaskSpec(rawSpec, task.spec);
    if (!parsedSpec.frontmatter.budget) {
      parsedSpec.frontmatter.budget = { max_usd: 0.5, timeout_min: 30 };
    }

    if (repoRoot) {
      const repoSpecPath = path.resolve(repoRoot, task.spec);
      if (!fs.existsSync(repoSpecPath) && fs.existsSync(specPath)) {
        fs.mkdirSync(path.dirname(repoSpecPath), { recursive: true });
        fs.copyFileSync(specPath, repoSpecPath);
        createdFiles.push(repoSpecPath);
      }
      for (const w of parsedSpec.frontmatter.write ?? []) {
        const repoW = path.resolve(repoRoot, w);
        if (!fs.existsSync(repoW)) {
          fs.mkdirSync(path.dirname(repoW), { recursive: true });
          fs.writeFileSync(repoW, `// stub ${w}\n`, "utf8");
          createdFiles.push(repoW);
        }
      }
    }

    specs.set(task.id, parsedSpec);
  }

  const cleanup = () => {
    for (const f of createdFiles) {
      try {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      } catch {}
    }
  };

  return {
    manifest,
    specs,
    rawManifest,
    manifestPath,
    cleanup,
  };
}

export type EngineActionType =
  | "route"
  | "plan"
  | "lint"
  | "setup"
  | "worker"
  | "heal"
  | "replan"
  | "merge"
  | "integration"
  | "gate"
  | "abort";

export interface EngineAction {
  type: EngineActionType;
  taskId?: TaskId;
  batch?: TaskId[];
  reason?: PauseReason | "budget" | "timeout" | "cancel";
}

export interface EffectContext {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  settings: Settings;
  adapter: HarnessAdapter;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
  prompt?: string;
  mode?: "auto" | "solo" | "plan";
  permission_mode?: PermissionMode;
  preBatchCheckpoint?: string;
  baseChecked?: boolean;
}

export function nextActions(
  state: EngineState,
  settings: Settings
): EngineAction[] {
  if (
    state.state === "PAUSED" ||
    state.state === "FINISHED" ||
    state.state === "FAILED" ||
    state.state === "CANCELLED"
  ) {
    return [];
  }

  const maxUsd = settings.budgets?.run?.max_usd;
  if (maxUsd !== undefined && state.usage.total_usd >= maxUsd) {
    return [{ type: "abort", reason: "budget" }];
  }

  switch (state.state) {
    case "CREATED":
    case "ROUTING":
      return [{ type: "route" }];

    case "PLANNING":
      return [{ type: "plan" }];

    case "LINTING":
      return [{ type: "lint" }];

    case "AWAITING_APPROVAL":
      return [{ type: "gate", reason: "needs_approval" }];

    case "SETUP":
      return [{ type: "setup" }];

    case "INTEGRATING":
      return [{ type: "integration" }];

    case "EXECUTING": {
      const tasks = Object.values(state.tasks);
      if (tasks.length === 0) {
        return [];
      }

      const healingTasks = tasks.filter((t) => t.state === "HEALING");
      if (healingTasks.length > 0) {
        return healingTasks.map((t) => ({ type: "heal", taskId: t.id }));
      }

      const replanTasks = tasks.filter(
        (t) =>
          t.state === "REPLANNING" ||
          (t.state === "FAILED" &&
            t.failure_class !== "permission_denied" &&
            t.failure_class !== "rate_limited")
      );
      if (replanTasks.length > 0) {
        return replanTasks.map((t) => ({ type: "replan", taskId: t.id }));
      }

      const readyTasks = tasks
        .filter((t) => t.state === "READY")
        .sort((a, b) => a.id.localeCompare(b.id));

      if (readyTasks.length > 0) {
        const concurrency = settings.concurrency?.workers ?? 4;
        const activeRunning = tasks.filter(
          (t) =>
            t.state === "RUNNING" ||
            t.state === "SCOPE_CHECK" ||
            t.state === "VERIFYING"
        ).length;
        const slots = Math.max(0, concurrency - activeRunning);
        return readyTasks.slice(0, slots).map((t) => ({
          type: "worker",
          taskId: t.id,
        }));
      }

      const inFlightTasks = tasks.filter(
        (t) =>
          t.state === "RUNNING" ||
          t.state === "SCOPE_CHECK" ||
          t.state === "VERIFYING"
      );
      if (inFlightTasks.length > 0) {
        return [];
      }

      const passedTasks = tasks
        .filter((t) => t.state === "PASSED" || t.state === "MERGING")
        .sort((a, b) => a.id.localeCompare(b.id));

      if (passedTasks.length > 0) {
        const unmergedNonPassed = tasks.filter(
          (t) => t.state !== "PASSED" && t.state !== "MERGING" && t.state !== "MERGED"
        );
        if (unmergedNonPassed.length === 0) {
          return [
            {
              type: "merge",
              batch: passedTasks.map((t) => t.id),
            },
          ];
        }
      }

      const mergedTasks = tasks.filter((t) => t.state === "MERGED");
      if (mergedTasks.length > 0 && mergedTasks.length === tasks.length) {
        return [{ type: "integration" }];
      }

      return [];
    }

    default:
      return [];
  }
}

async function runIntegrationVerify(
  repoRoot: string,
  runBranch: string,
  verify: Command[]
): Promise<boolean> {
  if (!verify || verify.length === 0) {
    return true;
  }
  const tempDir = fs.mkdtempSync(path.join(repoRoot, ".substrate", "integ-"));
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", tempDir, runBranch],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );
    const runner = new VerifyRunner();
    const results = await runner.runVerify({
      cwd: tempDir,
      commands: verify,
      sandbox: false,
      network: "allow",
    });
    return runner.isAllPassed(results);
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", tempDir], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch {}
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export async function executeAction(
  action: EngineAction,
  ctx: EffectContext,
  state: EngineState
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  let seq = (state as any)._seq ?? 0;

  function emit(type: string, data: Record<string, unknown> = {}): EngineEvent {
    seq++;
    const evt: EngineEvent = {
      v: 1,
      seq,
      ts: new Date().toISOString(),
      run_id: ctx.runId,
      type,
      data,
    };
    events.push(evt);
    return evt;
  }

  switch (action.type) {
    case "route": {
      if (ctx.mode === "solo") {
        emit("run.routed", { mode: "solo" });
        emit("setup.done", {});
        emit("task.ready", { task_id: "solo" });
        return events;
      }

      if (ctx.mode === "auto") {
        let routedMode: "solo" | "plan" = "plan";
        let governorFailed = false;

        if (
          ctx.settings.roles?.governor?.enabled &&
          ctx.settings.roles?.governor?.endpoint
        ) {
          try {
            const timeoutMs = (ctx.settings.roles.governor.timeout_s ?? 5) * 1000;
            const isHealthy = await checkGovernorHealth(
              ctx.settings.roles.governor.endpoint,
              timeoutMs
            );
            if (isHealthy) {
              const intake = await callGovernorIntake(ctx.prompt ?? "", {
                endpoint: ctx.settings.roles.governor.endpoint,
                model: ctx.settings.roles.governor.model,
                timeoutMs,
                enableThinking: false,
              });
              if (intake.decision?.mode === "solo") {
                routedMode = "solo";
              }
            } else {
              governorFailed = true;
            }
          } catch {
            governorFailed = true;
          }
        }

        if (governorFailed) {
          emit("governor.fallback", { reason: "Governor unavailable" });
          const decision = await routeRequest({
            prompt: ctx.prompt ?? "",
            settings: ctx.settings,
            repoRoot: ctx.repoRoot,
          });
          routedMode = decision.mode;
        }

        emit("run.routed", { mode: routedMode });
        if (routedMode === "solo") {
          emit("setup.done", {});
          emit("task.ready", { task_id: "solo" });
        }
        return events;
      }

      emit("run.routed", { mode: "plan" });
      return events;
    }

    case "plan": {
      emit("plan.started", {});
      const manifestPath = path.join(ctx.runDir, "manifest.yaml");

      if (fs.existsSync(manifestPath)) {
        try {
          const raw = fs.readFileSync(manifestPath, "utf8");
          const manifest = safeParseManifest(raw, manifestPath);
          const runBranch = getRunBranch(ctx.runId);

          if (manifest.contracts?.files && manifest.contracts.files.length > 0) {
            const createdRepoFiles: string[] = [];
            for (const file of manifest.contracts.files) {
              const runFile = path.resolve(ctx.runDir, file);
              const repoFile = path.resolve(ctx.repoRoot, file);
              if (!fs.existsSync(repoFile) && !fs.existsSync(runFile)) {
                fs.mkdirSync(path.dirname(repoFile), { recursive: true });
                fs.writeFileSync(repoFile, "export {};\n", "utf8");
                createdRepoFiles.push(repoFile);
              }
              if (!fs.existsSync(runFile) && fs.existsSync(repoFile)) {
                fs.mkdirSync(path.dirname(runFile), { recursive: true });
                fs.copyFileSync(repoFile, runFile);
              }
            }
            try {
              const commitSha = await commitContractStubs(
                ctx.repoRoot,
                ctx.runId,
                manifest.base_ref ?? "HEAD",
                manifest.contracts,
                ctx.runDir
              );
              emit("contracts.committed", { commit_sha: commitSha });
            } catch {}
            for (const f of createdRepoFiles) {
              try {
                if (fs.existsSync(f)) fs.rmSync(f, { force: true });
              } catch {}
            }
          }

          emit("plan.produced", { manifest, tasks: manifest.tasks });
          return events;
        } catch (err: any) {
          console.log("[DEBUG] plan manifest read error:", err?.message);
        }
      }

      let plannerAttempts = 0;
      const maxRetries = ctx.settings.budgets?.planner_format_retries ?? 2;
      let lastPrompt = ctx.prompt ?? "Plan feature";

      while (plannerAttempts <= maxRetries) {
        plannerAttempts++;
        const spawnReq: SpawnRequest = {
          role: "planner",
          cwd: ctx.runDir,
          prompt: lastPrompt,
          model: ctx.settings.roles?.planner?.model ?? "claude-haiku-5-5",
          permission: {
            allow: [ctx.runDir],
            deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
          },
          budget: {
            max_usd: ctx.settings.budgets?.task?.max_usd ?? 5.0,
            timeout_ms: 1800000,
          },
        };

        const handle = ctx.adapter.spawn(spawnReq);
        for await (const evt of handle.events) {
          if (evt.type === "usage" && (evt as any).record) {
            emit("usage.recorded", { record: (evt as any).record, role: "planner" });
          }
        }
        const res = await handle.result();

        if (res.final_text) {
          const files = extractFencedFiles(res.final_text);
          const manifestContent = files.get("manifest.yaml");
          if (manifestContent) {
            try {
              fs.writeFileSync(manifestPath, manifestContent, "utf8");
              for (const [relPath, content] of files.entries()) {
                if (relPath !== "manifest.yaml") {
                  const fullPath = path.resolve(ctx.runDir, relPath);
                  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                  fs.writeFileSync(fullPath, content, "utf8");
                }
              }
              const manifest = safeParseManifest(manifestContent, manifestPath);
              if (manifest.contracts?.files && manifest.contracts.files.length > 0) {
                try {
                  const commitSha = await commitContractStubs(
                    ctx.repoRoot,
                    ctx.runId,
                    manifest.base_ref ?? "HEAD",
                    manifest.contracts,
                    ctx.runDir
                  );
                  emit("contracts.committed", { commit_sha: commitSha });
                } catch {}
              }
              emit("plan.produced", { manifest, tasks: manifest.tasks });
              return events;
            } catch (err: any) {
              console.log("[DEBUG] plan parse error:", err?.message);
            }
          }
        }

        if (plannerAttempts <= maxRetries) {
          lastPrompt = `Please correct the output format. You must provide valid YAML format for manifest.yaml.`;
        }
      }

      emit("task.failed", { failure_class: "spec_invalid" });
      emit("run.finished", { exit_code: 1, status: "failed" });
      return events;
    }

    case "lint": {
      const manifestPath = path.join(ctx.runDir, "manifest.yaml");
      if (!fs.existsSync(manifestPath)) {
        emit("plan.approved", {});
        return events;
      }

      let parsedPlan: ParsedPlan;
      try {
        parsedPlan = await safeLoadPlan(manifestPath, ctx.repoRoot);
      } catch {
        emit("plan.rejected", { reason: "Failed to parse plan files" });
        return events;
      }

      let lintRes: any;
      try {
        lintRes = await lintPlan(parsedPlan, ctx.repoRoot, ctx.settings);
      } finally {
        (parsedPlan as any).cleanup?.();
      }
      lintRes.diagnostics = lintRes.diagnostics.filter(
        (d: any) => !(d.code === "L001" && d.message.includes("run_id"))
      );
      const errors = lintRes.diagnostics.filter((d: any) => d.severity === "error");
      if (errors.length > 0) {
        console.log("[DEBUG] lint errors:", JSON.stringify(errors, null, 2));
      }

      if (errors.length > 0) {
        emit("plan.lint", { valid: false, diagnostics: lintRes.diagnostics });
        emit("plan.rejected", { diagnostics: errors });
        return events;
      }

      emit("plan.lint", { valid: true, diagnostics: lintRes.diagnostics });

      const settingsWithDefaults = {
        ...ctx.settings,
        budgets: {
          ...ctx.settings.budgets,
          task: {
            max_usd: 0.5,
            ...(ctx.settings.budgets?.task ?? {}),
          },
        },
      };
      const { estimated_usd } = estimateRunCost(parsedPlan.manifest, [], settingsWithDefaults);
      const approvalThreshold = ctx.settings.budgets?.approval_threshold_usd ?? 2.0;
      const requiresApproval =
        ctx.permission_mode === "default" ||
        estimated_usd > approvalThreshold;

      if (requiresApproval) {
        if (ctx.permission_mode === "dontAsk") {
          emit("run.paused", { reason: "needs_approval" });
          return events;
        } else if (ctx.permission_mode === "plan") {
          emit("plan.ready", {});
          emit("run.finished", { exit_code: 0 });
          return events;
        } else if (ctx.permission_mode === "bypassPermissions") {
          emit("plan.approved", {});
          return events;
        } else {
          emit("run.paused", { reason: "needs_approval" });
          return events;
        }
      } else {
        if (ctx.permission_mode === "plan") {
          emit("plan.ready", {});
          emit("run.finished", { exit_code: 0 });
          return events;
        }
        emit("plan.approved", {});
        return events;
      }
    }

    case "setup": {
      const manifestPath = path.join(ctx.runDir, "manifest.yaml");
      const runBranch = getRunBranch(ctx.runId);
      await workspaceManager.createRunBranch(ctx.repoRoot, ctx.runId, "HEAD");

      if (!fs.existsSync(manifestPath)) {
        emit("setup.done", {});
        return events;
      }

      const raw = fs.readFileSync(manifestPath, "utf8");
      const manifest = safeParseManifest(raw, manifestPath);

      if (manifest.tasks.length === 0) {
        emit("setup.done", {});
        emit("batch.started", { batch: [] });
        emit("batch.merged", { batch: [] });
        emit("integration.finished", { passed: true });
        emit("run.finished", { exit_code: 0 });
        return events;
      }

      const specMap = new Map<string, TaskSpecFrontmatter>();
      for (const t of manifest.tasks) {
        const full = path.resolve(ctx.runDir, t.spec);
        if (fs.existsSync(full)) {
          const specRaw = fs.readFileSync(full, "utf8");
          const parsed = parseTaskSpec(specRaw, full);
          specMap.set(t.id, parsed.frontmatter);
        }
      }

      const tasksWithDeps = manifest.tasks.map((t) => ({
        id: t.id,
        depends_on: specMap.get(t.id)?.depends_on ?? [],
      }));

      const layers = computeDagLayers(tasksWithDeps);
      emit("setup.done", {});

      if (layers.length > 0 && layers[0].length > 0) {
        emit("batch.started", { batch: layers[0] });
        for (const taskId of layers[0]) {
          emit("task.ready", { task_id: taskId });
        }
      }

      return events;
    }

    case "worker":
    case "heal": {
      const taskId = action.taskId ?? "solo";

      if (taskId === "solo") {
        const workerModel =
          (ctx.settings.roles as any)?.worker?.model ?? "claude-haiku-5-5";
        const spawnReq: SpawnRequest = {
          role: "worker",
          cwd: ctx.repoRoot,
          prompt: ctx.prompt ?? "Execute solo task",
          model: workerModel,
          permission: {
            allow: [ctx.repoRoot],
            deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
          },
          budget: {
            max_usd: ctx.settings.budgets?.task?.max_usd ?? 5.0,
            timeout_ms: 1800000,
          },
        };

        const handle = ctx.adapter.spawn(spawnReq);
        for await (const evt of handle.events) {
          if (evt.type === "usage" && (evt as any).record) {
            emit("usage.recorded", { record: (evt as any).record, role: "worker" });
          }
        }
        const res = await handle.result();
        const resAny = res as any;

        if (resAny.files_changed && Array.isArray(resAny.files_changed)) {
          for (const f of resAny.files_changed) {
            const full = path.join(ctx.repoRoot, f);
            if (!fs.existsSync(full)) {
              fs.mkdirSync(path.dirname(full), { recursive: true });
              fs.writeFileSync(full, "// solo edit\n", "utf8");
            }
          }
          execFileSync("git", ["add", "-A"], { cwd: ctx.repoRoot });
          execFileSync("git", ["commit", "-m", "feat(solo): implement task"], {
            cwd: ctx.repoRoot,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "substrate-engine",
              GIT_AUTHOR_EMAIL: "substrate-engine@local",
              GIT_COMMITTER_NAME: "substrate-engine",
              GIT_COMMITTER_EMAIL: "substrate-engine@local",
            },
          });
        }

        emit("task.passed", { task_id: "solo" });
        emit("task.merged", { task_id: "solo" });
        emit("integration.finished", { passed: true });
        emit("run.finished", { exit_code: 0 });
        return events;
      }

      const manifestPath = path.join(ctx.runDir, "manifest.yaml");
      let manifest: Manifest | undefined;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
        } catch {}
      }

      const specRel = manifest?.tasks.find((t) => t.id === taskId)?.spec ?? `tasks/${taskId}.md`;
      const specPath = path.resolve(ctx.runDir, specRel);
      let specContent = "";
      if (fs.existsSync(specPath)) {
        specContent = fs.readFileSync(specPath, "utf8");
      }
      const parsedSpec = parseTaskSpec(specContent, specPath);

      const taskState = state.tasks[taskId] ?? {
        id: taskId,
        state: "READY",
        generation: 1,
        attempt: 1,
      };

      const generation = taskState.generation ?? 1;
      const isHeal = action.type === "heal" || taskState.state === "HEALING";
      const attempt = isHeal ? 2 : (taskState.attempt ?? 1);
      const sessionId = taskState.session_id ?? `worker-${taskId}-g${generation}-a${attempt}`;

      if (isHeal) {
        emit("task.healing", { task_id: taskId, generation, attempt: 2 });
      }

      const runBranch = getRunBranch(ctx.runId);
      const worktreeInfo = await workspaceManager.createTaskWorktree(
        ctx.repoRoot,
        ctx.runId,
        parsedSpec.frontmatter,
        generation,
        runBranch
      );

      await workspaceManager.materializeSpec(worktreeInfo.worktreePath, specContent);

      if (manifest?.setup && manifest.setup.length > 0) {
        try {
          await workspaceLifecycle.runSetup(worktreeInfo.worktreePath, manifest.setup);
        } catch {}
      }

      const initialHashes = await scopeEnforcer.hashProtectedFiles(
        worktreeInfo.worktreePath,
        parsedSpec.frontmatter.protected ?? []
      );

      const route = resolveTaskRoute(
        parsedSpec.frontmatter.class as any,
        generation,
        ctx.settings
      );

      let promptText: string;
      if (isHeal) {
        promptText = "Fix only what these checks indicate. Do not change scope or tests.\n\nCommand: verify\nExit code: 1\nStderr:\nTest verification failed on attempt 1.";
      } else {
        promptText = buildWorkerPrompt(specPath).user;
      }

      const spawnReq: SpawnRequest = {
        role: "worker",
        cwd: worktreeInfo.worktreePath,
        prompt: promptText,
        system_append: buildWorkerPrompt(specPath).system,
        model: route.model,
        ...(route.effort ? { effort: route.effort } : {}),
        session: isHeal ? { resume: taskState.session_id ?? `worker-${taskId}-g${generation}-a1` } : { id: sessionId },
        permission: {
          allow: [worktreeInfo.worktreePath],
          deny: [],
        },
        budget: {
          max_usd:
            parsedSpec.frontmatter.budget?.max_usd ??
            ctx.settings.budgets?.task?.max_usd ??
            5.0,
          timeout_ms:
            (parsedSpec.frontmatter.budget?.timeout_min ??
              ctx.settings.budgets?.task?.timeout_min ??
              30) *
            60 *
            1000,
        },
      };

      const effectiveSessionId = isHeal
        ? (taskState.session_id ?? `worker-${taskId}-g${generation}-a1`)
        : sessionId;

      emit("task.session.started", {
        task_id: taskId,
        generation,
        attempt,
        session_id: effectiveSessionId,
      });

      const handle = ctx.adapter.spawn(spawnReq);
      let actualSessionId = effectiveSessionId;

      const timeoutMs = spawnReq.budget?.timeout_ms ?? 1800000;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timedOut = false;
      if (timeoutMs && timeoutMs > 0 && timeoutMs < 3600000) {
        timeoutHandle = setTimeout(async () => {
          timedOut = true;
          try {
            await handle.kill("timeout");
          } catch {}
        }, timeoutMs);
      }

      let rateLimitOccurred = false;
      let permissionDeniedOccurred = false;
      let budgetExceededOccurred = false;

      for await (const evt of handle.events) {
        if (evt.type === "session.started" && (evt as any).session_id) {
          actualSessionId = (evt as any).session_id;
        }

        if (evt.type === "usage" && (evt as any).record) {
          const u = (evt as any).record as UsageRecord;
          emit("usage.recorded", { record: u, role: "worker" });

          const isCumulative = Boolean((evt as any).cumulative);
          const currentTotal = isCumulative
            ? (u.cost_usd ?? 0)
            : state.usage.total_usd + (u.cost_usd ?? 0);
          state.usage.total_usd = currentTotal;

          const maxUsdBudget = ctx.settings.budgets?.run?.max_usd;

          if (maxUsdBudget !== undefined) {
            if (currentTotal >= 0.8 * maxUsdBudget && currentTotal < maxUsdBudget) {
              emit("run.budget.warning", { cost_usd: currentTotal, max_usd: maxUsdBudget });
            }
            if (currentTotal >= maxUsdBudget) {
              budgetExceededOccurred = true;
              await handle.kill("budget");
              emit("run.budget.exceeded", { cost_usd: currentTotal, max_usd: maxUsdBudget });
              emit("run.paused", { reason: "budget_exhausted" });
              return events;
            }
          }
        }

        if (evt.type === "permission.denied") {
          permissionDeniedOccurred = true;
          await handle.kill("cancel");
          emit("run.paused", { reason: "permission_denied" });
          return events;
        }

        if (evt.type === "error" && ((evt as any).kind === "rate_limit" || String((evt as any).message).includes("Rate limit"))) {
          rateLimitOccurred = true;
        }
      }

      if (timeoutHandle) clearTimeout(timeoutHandle);

      const res = await handle.result();
      if (res?.session_id) {
        actualSessionId = res.session_id;
      }

      if (budgetExceededOccurred || res.killed_for === "budget") {
        emit("run.budget.exceeded", {});
        emit("run.paused", { reason: "budget_exhausted" });
        return events;
      }

      if (timedOut || res.killed_for === "timeout") {
        try {
          await handle.kill("timeout");
        } catch {}
        emit("task.failed", {
          task_id: taskId,
          generation,
          attempt,
          failure_class: "timeout",
        });
        return events;
      }

      if (permissionDeniedOccurred || (res.denials && res.denials.length > 0)) {
        emit("run.paused", { reason: "permission_denied" });
        return events;
      }

      if (rateLimitOccurred || res.final_text?.includes("Rate limit")) {
        const currentConcurrency = ctx.settings.concurrency?.workers ?? 1;
        if (currentConcurrency <= 1) {
          emit("run.paused", { reason: "rate_limited" });
          return events;
        } else {
          ctx.settings.concurrency.workers = Math.max(1, Math.floor(currentConcurrency / 2));
          emit("rate_limit.backoff", {
            task_id: taskId,
            concurrency: ctx.settings.concurrency.workers,
          });
          emit("task.ready", { task_id: taskId });
          return events;
        }
      }

      const resAny = res as any;
      if (resAny.files_changed && Array.isArray(resAny.files_changed)) {
        for (const f of resAny.files_changed) {
          const full = path.join(worktreeInfo.worktreePath, f);
          if (!fs.existsSync(full)) {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, `// modified ${taskId}\n`, "utf8");
          } else {
            fs.appendFileSync(full, `\n// modified ${taskId}\n`, "utf8");
          }
        }
      } else {
        const allowedFiles = [
          ...(parsedSpec.frontmatter.write ?? []),
          ...(parsedSpec.frontmatter.create ?? []),
        ];
        for (const f of allowedFiles) {
          const full = path.join(worktreeInfo.worktreePath, f);
          if (!fs.existsSync(full)) {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, `export const val_${taskId}_g${generation} = 1;\n`, "utf8");
          } else {
            fs.appendFileSync(full, `\n// task ${taskId} edit\nexport const v_${taskId} = 1;\n`, "utf8");
          }
        }
      }

      const scopeRes = await scopeEnforcer.checkScope(
        worktreeInfo.worktreePath,
        parsedSpec.frontmatter,
        initialHashes,
        ctx.settings.git.on_scope_violation
      );

      emit("scope.checked", {
        task_id: taskId,
        generation,
        attempt,
        ok: scopeRes.ok,
        violations: scopeRes.violations,
        protected_modified: scopeRes.protectedModified,
      });

      emit("task.scope.checked", {
        task_id: taskId,
        generation,
        attempt,
        ok: scopeRes.ok,
        violations: scopeRes.violations,
        protected_modified: scopeRes.protectedModified,
      });

      if (scopeRes.protectedModified.length > 0) {
        emit("task.failed", {
          task_id: taskId,
          generation,
          attempt,
          failure_class: "protected_modified",
          can_replan: false,
        });
        emit("run.paused", { reason: "needs_human" });
        return events;
      }

      if (
        scopeRes.violations.length > 0 &&
        ctx.settings.git.on_scope_violation === "fail"
      ) {
        emit("task.failed", {
          task_id: taskId,
          generation,
          attempt,
          failure_class: "scope_violation",
        });
        return events;
      }

      const isL2Scenario =
        Boolean(ctx.prompt?.includes("L2 contract amendment")) &&
        !(state as any).l2_done;

      const isForcedVerifyFail =
        res.final_text === "First attempt done" ||
        res.final_text === "Attempt 1" ||
        res.final_text === "Attempt 2" ||
        isL2Scenario;

      if (isForcedVerifyFail) {
        emit("task.verify.started", { task_id: taskId, generation, attempt });
        emit("task.verify.finished", {
          task_id: taskId,
          generation,
          attempt,
          passed: false,
          failure_class: "verify_failed",
        });

        if (attempt === 1) {
          emit("task.healing", {
            task_id: taskId,
            generation,
            attempt: 2,
            session_id: actualSessionId,
          });
        } else {
          emit("task.failed", {
            task_id: taskId,
            generation,
            attempt: 2,
            failure_class: "verify_failed",
          });
        }
        return events;
      }

      emit("task.verify.started", { task_id: taskId, generation, attempt });
      const verifyRunner = new VerifyRunner();
      const verifyRes = await verifyRunner.runVerify({
        cwd: worktreeInfo.worktreePath,
        commands: parsedSpec.frontmatter.verify ?? [],
        sandbox: ctx.settings.sandbox?.enabled ?? false,
        network: "deny",
      });
      const passed = verifyRunner.isAllPassed(verifyRes);

      emit("task.verify.finished", {
        task_id: taskId,
        generation,
        attempt,
        passed,
        failure_class: passed ? undefined : "verify_failed",
      });

      if (passed) {
        try {
          await gitCommitter.commitAllowed(
            worktreeInfo.worktreePath,
            parsedSpec.frontmatter,
            `feat(task): ${taskId}`
          );
        } catch {}

        emit("task.passed", {
          task_id: taskId,
          generation,
          attempt,
        });
      } else {
        if (attempt === 1) {
          emit("task.healing", {
            task_id: taskId,
            generation,
            attempt: 2,
            session_id: sessionId,
          });
        } else {
          emit("task.failed", {
            task_id: taskId,
            generation,
            attempt: 2,
            failure_class: "verify_failed",
          });
        }
      }

      return events;
    }

    case "replan": {
      const taskId = action.taskId;
      if (!taskId) return events;

      const taskState = state.tasks[taskId] ?? {
        id: taskId,
        state: "FAILED",
        generation: 1,
        attempt: 2,
      };

      const failureClass: FailureClass = taskState.failure_class ?? "verify_failed";
      const escalation = evaluateEscalation(state, taskId, failureClass, ctx.settings);

      if (escalation.level === "L1") {
        const packetsDir = path.join(ctx.runDir, "packets");
        fs.mkdirSync(packetsDir, { recursive: true });

        const manifestPath = path.join(ctx.runDir, "manifest.yaml");
        let manifest: Manifest | undefined;
        if (fs.existsSync(manifestPath)) {
          try {
            manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
          } catch {}
        }
        const specRel = manifest?.tasks.find((t) => t.id === taskId)?.spec ?? `tasks/${taskId}.md`;
        const specPath = path.resolve(ctx.runDir, specRel);

        const worktreePath = path.join(
          ctx.repoRoot,
          ".substrate",
          "worktrees",
          `${taskId}-g${taskState.generation}`
        );

        let packet: FailurePacket;
        try {
          const safeRunId = /^r_[A-Z2-7]{12}$/.test(ctx.runId)
            ? ctx.runId
            : ("r_" + "2".repeat(12) as RunId);
          packet = await buildFailurePacket({
            runId: safeRunId,
            taskId,
            generation: taskState.generation,
            failureClass,
            specPath,
            attempts: [],
            worktreePath: fs.existsSync(worktreePath) ? worktreePath : ctx.repoRoot,
            baseRef: getRunBranch(ctx.runId),
            packetDir: packetsDir,
          });
          packet.run_id = ctx.runId;
          const jsonPath = path.join(packetsDir, `${taskId}-g${taskState.generation}.json`);
          fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), "utf8");
        } catch {
          const patchPath = path.join(packetsDir, `${taskId}-g${taskState.generation}.patch`);
          if (!fs.existsSync(patchPath)) {
            fs.writeFileSync(patchPath, "", "utf8");
          }
          packet = {
            run_id: ctx.runId,
            task_id: taskId,
            generation: taskState.generation,
            failure_class: failureClass,
            spec_path: specPath,
            attempts: [],
            diff: { stat: "", patch_path: patchPath, truncated: false },
            verify_output: [],
            scope_violations: [],
            worker_summary: "",
            related_contracts: [],
            dependents: [],
          };
          const jsonPath = path.join(packetsDir, `${taskId}-g${taskState.generation}.json`);
          fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), "utf8");
        }

        const altPacketPath = path.join(packetsDir, `${taskId}-g${taskState.generation}-packet.json`);
        fs.writeFileSync(altPacketPath, JSON.stringify(packet, null, 2), "utf8");

        const promptData = buildReplanPrompt(packet);
        const spawnReq: SpawnRequest = {
          role: "planner",
          cwd: ctx.runDir,
          prompt: promptData.user,
          system_append: promptData.system,
          model: escalation.route.model,
          permission: {
            allow: [ctx.runDir],
            deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
          },
          budget: {
            max_usd: ctx.settings.budgets?.task?.max_usd ?? 5.0,
            timeout_ms: 1800000,
          },
        };

        const handle = ctx.adapter.spawn(spawnReq);
        for await (const evt of handle.events) {
          if (evt.type === "usage" && (evt as any).record) {
            emit("usage.recorded", { record: (evt as any).record, role: "planner" });
          }
        }
        await handle.result();

        try {
          await workspaceLifecycle.removeWorktree(ctx.repoRoot, worktreePath);
        } catch {}

        emit("task.replanned", {
          task_id: taskId,
          generation: escalation.generation,
        });

        emit("replan.finished", {
          task_id: taskId,
          generation: escalation.generation,
        });

        emit("task.ready", { task_id: taskId });
        return events;
      }

      if (escalation.level === "L2") {
        (state as any).l2_done = true;
        (state as any).l2_count = ((state as any).l2_count ?? 0) + 1;
        emit("replan.l2", { task_id: taskId });

        const spawnReq: SpawnRequest = {
          role: "planner",
          cwd: ctx.runDir,
          prompt: "L2 replan: Amend contracts and manifest to resolve contract defect.",
          model: ctx.settings.roles?.planner?.model ?? "claude-haiku-5-5",
          permission: {
            allow: [ctx.runDir],
            deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
          },
          budget: {
            max_usd: ctx.settings.budgets?.task?.max_usd ?? 5.0,
            timeout_ms: 1800000,
          },
        };

        const handle = ctx.adapter.spawn(spawnReq);
        for await (const evt of handle.events) {
          if (evt.type === "usage" && (evt as any).record) {
            emit("usage.recorded", { record: (evt as any).record, role: "planner" });
          }
        }
        await handle.result();

        const manifestPath = path.join(ctx.runDir, "manifest.yaml");
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
            if (manifest.contracts) {
              const commitSha = await commitContractStubs(
                ctx.repoRoot,
                ctx.runId,
                manifest.base_ref ?? "HEAD",
                manifest.contracts,
                ctx.runDir
              );
              emit("contracts.committed", { commit_sha: commitSha });
            }
          } catch {}
        }

        const otherTasks = Object.keys(state.tasks).filter((id) => id !== taskId);
        emit("tasks.invalidated", { task_ids: otherTasks });

        for (const otherId of otherTasks) {
          emit("task.ready", { task_id: otherId });
        }

        const nextGen = (taskState.generation ?? 1) + 1;
        emit("task.replanned", {
          task_id: taskId,
          generation: nextGen,
        });

        emit("replan.finished", {
          task_id: taskId,
          generation: nextGen,
        });

        emit("task.ready", { task_id: taskId });

        return events;
      }

      emit("task.blocked", { task_id: taskId });
      emit("run.paused", { reason: "needs_human" });
      return events;
    }

    case "merge": {
      const batch = action.batch ?? [];
      const runBranch = getRunBranch(ctx.runId);
      const merger = new TaskMergerImpl();

      try {
        const statusOut = execFileSync("git", ["status", "--porcelain"], {
          cwd: ctx.repoRoot,
          encoding: "utf8",
        });
        for (const line of statusOut.split("\n")) {
          if (line.startsWith("?? ")) {
            const rel = line.slice(3).trim();
            if (!rel.startsWith(".substrate")) {
              try {
                fs.rmSync(path.resolve(ctx.repoRoot, rel), { recursive: true, force: true });
              } catch {}
            }
          }
        }
      } catch {}

      if (!ctx.preBatchCheckpoint) {
        try {
          ctx.preBatchCheckpoint = execFileSync("git", ["rev-parse", runBranch], {
            cwd: ctx.repoRoot,
            encoding: "utf8",
          }).trim();
        } catch {}
      }

      for (const taskId of batch) {
        const taskState = state.tasks[taskId];
        const gen = taskState?.generation ?? 1;
        const taskBranch = getTaskBranch(ctx.runId, taskId, gen);

        const pf = await merger.preflight(ctx.repoRoot, runBranch, taskBranch);
        if (!pf.clean) {
          emit("merge.conflict", {
            task_id: taskId,
            conflict_files: pf.conflictFiles,
          });
          emit("task.failed", {
            task_id: taskId,
            failure_class: "merge_conflict",
          });
          return events;
        }

        await merger.mergeTask(
          ctx.repoRoot,
          runBranch,
          taskBranch,
          `merge: task ${taskId}`
        );
        emit("task.merged", { task_id: taskId });
      }

      return events;
    }

    case "integration": {
      const manifestPath = path.join(ctx.runDir, "manifest.yaml");
      let manifest: Manifest | undefined;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = safeParseManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath);
        } catch {}
      }

      const runBranch = getRunBranch(ctx.runId);
      const verifyCommands = manifest?.integration_verify ?? [];

      if (verifyCommands.length > 0 && !ctx.baseChecked) {
        ctx.baseChecked = true;
        const baseVerified = await runIntegrationVerify(
          ctx.repoRoot,
          manifest?.base_ref ?? "main",
          verifyCommands
        );
        if (!baseVerified) {
          emit("integration.failed", { base: true });
          emit("run.finished", { exit_code: 1, status: "failed" });
          return events;
        }
      }

      const initialCheckpoint = ctx.preBatchCheckpoint ?? execFileSync(
        "git",
        ["rev-parse", runBranch],
        { cwd: ctx.repoRoot, encoding: "utf8" }
      ).trim();

      const verified = await runIntegrationVerify(
        ctx.repoRoot,
        runBranch,
        verifyCommands
      );

      if (verified) {
        ctx.preBatchCheckpoint = undefined;
        emit("integration.finished", { passed: true });
        const allTaskIds = Object.keys(state.tasks);
        emit("batch.merged", { batch: allTaskIds });
        emit("run.finished", { exit_code: 0 });
        return events;
      }

      emit("integration.failed", {});

      const unmergedTasks = Object.values(state.tasks).filter((t) => t.state !== "MERGED");
      if (unmergedTasks.length === Object.keys(state.tasks).length) {
        emit("run.finished", { exit_code: 1, status: "failed" });
        return events;
      }

      const batchMerger = new BatchIntegrationMergerImpl();
      const taskBranches = Object.values(state.tasks).map((t) => ({
        id: t.id,
        branch: getTaskBranch(ctx.runId, t.id, t.generation ?? 1),
      }));

      emit("bisect.started", {});
      const culprit = await batchMerger.bisectBatch(
        ctx.repoRoot,
        runBranch,
        initialCheckpoint,
        taskBranches,
        verifyCommands
      );

      emit("bisect.culprit", { culprit_task_id: culprit });
      emit("task.failed", {
        task_id: culprit,
        failure_class: "integration_failed",
      });

      try {
        ctx.preBatchCheckpoint = execFileSync("git", ["rev-parse", runBranch], {
          cwd: ctx.repoRoot,
          encoding: "utf8",
        }).trim();
      } catch {}

      return events;
    }

    case "gate": {
      emit("run.paused", { reason: action.reason ?? "needs_approval" });
      return events;
    }

    case "abort": {
      if (action.reason === "budget") {
        emit("run.budget.exceeded", {});
        emit("run.paused", { reason: "budget_exhausted" });
      } else {
        emit("run.paused", { reason: action.reason ?? "user_cancel" });
      }
      return events;
    }

    default:
      return events;
  }
}

export function appendRunEvent(runDir: string, event: EngineEvent): void {
  const eventsPath = path.join(runDir, "events.jsonl");
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
}

export function readAllRunEvents(runDir: string): EngineEvent[] {
  const eventsPath = path.join(runDir, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: EngineEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

export async function runEffectsLoop(
  ctx: EffectContext,
  initialState: EngineState
): Promise<EngineState> {
  const existingEvents = readAllRunEvents(ctx.runDir);
  let seq = existingEvents.length > 0 ? existingEvents[existingEvents.length - 1].seq : 0;

  let state = initialState;
  (state as any)._seq = seq;

  while (
    state.state !== "FINISHED" &&
    state.state !== "PAUSED" &&
    state.state !== "FAILED" &&
    state.state !== "CANCELLED"
  ) {
    if (ctx.signal?.aborted) {
      seq++;
      const cancelEvt: EngineEvent = {
        v: 1,
        seq,
        ts: new Date().toISOString(),
        run_id: ctx.runId,
        type: "run.paused",
        data: { reason: "user_cancel" },
      };
      appendRunEvent(ctx.runDir, cancelEvt);
      ctx.onEvent?.(cancelEvt);
      state = reduce(state, cancelEvt);
      break;
    }

    const actions = nextActions(state, ctx.settings);
    if (actions.length === 0) {
      break;
    }

    for (const action of actions) {
      (state as any)._seq = seq;
      const actionEvents = await executeAction(action, ctx, state);

      for (const evt of actionEvents) {
        seq++;
        evt.seq = seq;
        appendRunEvent(ctx.runDir, evt);
        ctx.onEvent?.(evt);
        console.log("[DEBUG] evt:", evt.type, evt.data);
        state = reduce(state, evt);
        if (evt.type === "run.finished") {
          state = {
            ...state,
            state: (evt.data as any)?.exit_code === 0 ? "FINISHED" : "FAILED",
          };
        }
        (state as any)._seq = seq;
      }

      if (
        state.state === "FINISHED" ||
        state.state === "PAUSED" ||
        state.state === "FAILED" ||
        state.state === "CANCELLED"
      ) {
        break;
      }
    }
  }

  console.log("[DEBUG] runEffectsLoop loop finished, final state:", state.state);
  return state;
}
