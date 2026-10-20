import fs from "node:fs";
import path from "node:path";

import type { Effort, HarnessAdapter, PermissionMode, Settings } from "../contracts/index.js";
import { RunRequest } from "../contracts/request.js";
import { loadSettings, modelCacheFile } from "../config/index.js";
import { createAdapters } from "../backends/registry.js";

export interface ModelEntry {
  id: string;
  provider: string;
  display?: string;
  efforts: string[];
  slots: string[];
}

export interface ProviderEntry {
  provider: "claude" | "opencode" | "agy";
  installed: boolean;
  version?: string;
  models: ModelEntry[];
}

export interface ModelCatalog {
  v: 1;
  generated_at: string;
  cache: "fresh" | "cached";
  providers: ProviderEntry[];
  all_models: ModelEntry[];
}

export interface Problem {
  field: string;
  message: string;
  fix: string;
}

export type RunRequestResult =
  | { ok: true; request: RunRequest; overrides: Record<string, any>; plannerExplicit: boolean }
  | { ok: false; problems: Problem[] };

export interface LoadRequestOptions {
  repoRoot?: string;
  settings?: Settings;
  catalog?: ModelCatalog;
  adapters?: Record<string, HarnessAdapter>;
  rawPrompt?: string;
}

function parseRoleSpec(spec: string): { provider?: "claude" | "opencode" | "agy"; model?: string; effort?: Effort } {
  const parts = spec.split(":");
  const provider = parts[0] as "claude" | "opencode" | "agy" | undefined;
  const model = parts[1] || undefined;
  const effort = (parts[2] as Effort) || undefined;
  return { provider, model, effort };
}

async function getCatalog(
  settings: Settings,
  options: LoadRequestOptions
): Promise<ModelCatalog> {
  if (options.catalog) return options.catalog;
  const adapters = options.adapters ?? createAdapters(settings);
  const repoRoot = options.repoRoot ?? process.cwd();
  const { buildCatalog } = await import(`./model-catalog.js`);
  return (await buildCatalog({
    settings,
    adapters,
    refresh: false,
    cacheFile: modelCacheFile(repoRoot),
  })) as unknown as ModelCatalog;
}

export async function loadRequest(
  source: string | undefined,
  stdin: string | undefined,
  flags: Record<string, any> = {},
  options: LoadRequestOptions = {}
): Promise<RunRequestResult> {
  const problems: Problem[] = [];
  const repoRoot = options.repoRoot ?? process.cwd();
  let rawObj: Record<string, any> = {};

  if (source !== undefined) {
    if (options.rawPrompt !== undefined && options.rawPrompt.trim().length > 0) {
      problems.push({
        field: "goal",
        message: "both a prompt and a request file were given",
        fix: "provide either a prompt or a request file, not both",
      });
    }

    let rawText = "";
    if (source === "-") {
      if (stdin === undefined || stdin.trim().length === 0) {
        return {
          ok: false,
          problems: [
            {
              field: "request",
              message: "stdin is empty",
              fix: "provide request JSON on stdin",
            },
          ],
        };
      }
      rawText = stdin;
    } else {
      const resolved = path.isAbsolute(source) ? source : path.resolve(repoRoot, source);
      if (!fs.existsSync(resolved)) {
        return {
          ok: false,
          problems: [
            {
              field: "request",
              message: `file not found: ${source}`,
              fix: "provide an existing request file",
            },
          ],
        };
      }
      rawText = fs.readFileSync(resolved, "utf8");
    }

    try {
      rawObj = JSON.parse(rawText);
    } catch (err: any) {
      return {
        ok: false,
        problems: [
          {
            field: "request",
            message: err.message,
            fix: "provide valid JSON",
          },
        ],
      };
    }
  } else {
    if (options.rawPrompt) {
      rawObj.goal = options.rawPrompt;
    }
  }

  if (typeof rawObj !== "object" || rawObj === null || Array.isArray(rawObj)) {
    return {
      ok: false,
      problems: [
        {
          field: "request",
          message: "expected JSON object",
          fix: "provide a JSON object",
        },
      ],
    };
  }

  // Reject scope (Behavior 3)
  if ("scope" in rawObj) {
    problems.push({
      field: "scope",
      message: "scope is not enforced in this version",
      fix: "remove scope",
    });
    delete rawObj.scope;
  }

  // A planner named by the caller (--plan, or a planner object in the payload) is
  // recorded before the flag overrides below fill in planner fields from --model and
  // --effort. Auto mode reads it to keep the run on the plan route (R6.4).
  const plannerExplicit = rawObj.planner !== undefined || flags.plan !== undefined;

  // Flag overrides
  if (flags.mode !== undefined) {
    rawObj.mode = flags.mode;
  }
  if (flags.permissionMode !== undefined) {
    rawObj.permission_mode = flags.permissionMode;
  }
  if (flags.verify !== undefined) {
    rawObj.verify = flags.verify;
  }
  if (flags.plan !== undefined) {
    const parsed = parseRoleSpec(flags.plan);
    rawObj.planner = { ...(rawObj.planner ?? {}), ...parsed };
  }
  if (flags.work !== undefined) {
    const parsed = parseRoleSpec(flags.work);
    rawObj.worker = { ...(rawObj.worker ?? {}), ...parsed };
  }
  if (flags.model !== undefined) {
    const effectiveMode = flags.mode ?? rawObj.mode ?? "auto";
    if (effectiveMode === "solo") {
      rawObj.worker = { ...(rawObj.worker ?? {}), model: flags.model };
    } else {
      rawObj.planner = { ...(rawObj.planner ?? {}), model: flags.model };
    }
  }
  if (flags.workerModel !== undefined) {
    rawObj.worker = { ...(rawObj.worker ?? {}), model: flags.workerModel };
  }
  if (flags.effort !== undefined) {
    rawObj.planner = { ...(rawObj.planner ?? {}), effort: flags.effort };
  }
  if (flags.maxBudgetUsd !== undefined || flags.timeout !== undefined) {
    rawObj.budget = rawObj.budget ?? {};
    if (flags.maxBudgetUsd !== undefined) rawObj.budget.max_usd = flags.maxBudgetUsd;
    if (flags.timeout !== undefined) rawObj.budget.max_wall_min = flags.timeout / 60;
  }

  // Validate RunRequest schema
  const parseResult = RunRequest.safeParse(rawObj);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const k of issue.keys) {
          if (k === "scope") {
            // Already handled above if present, but catch here too
            if (!problems.some((p) => p.field === "scope")) {
              problems.push({
                field: "scope",
                message: "scope is not enforced in this version",
                fix: "remove scope",
              });
            }
          } else {
            problems.push({
              field: k,
              message: `unrecognized key '${k}'`,
              fix: `remove the unknown key '${k}'`,
            });
          }
        }
      } else {
        const field = issue.path.join(".");
        if (field === "goal") {
          problems.push({
            field: "goal",
            message: "goal must not be empty",
            fix: "provide a non-empty goal",
          });
        } else if (field.startsWith("context")) {
          problems.push({
            field,
            message: issue.message,
            fix: "provide valid context file paths",
          });
        } else if (field.startsWith("verify")) {
          problems.push({
            field,
            message: issue.message,
            fix: "provide valid verify commands",
          });
        } else {
          problems.push({
            field: field || "request",
            message: issue.message,
            fix: `fix invalid ${field || "request"}`,
          });
        }
      }
    }
  }

  // Check context files existence (Behavior 4)
  if (rawObj.context && Array.isArray(rawObj.context)) {
    rawObj.context.forEach((p: string, i: number) => {
      const absPath = path.resolve(repoRoot, p);
      if (!fs.existsSync(absPath)) {
        problems.push({
          field: `context[${i}]`,
          message: `file not found: ${p}`,
          fix: "provide an existing repo-relative path",
        });
      }
    });
  }

  // Conflicts: --mode solo with --plan (Behavior 8)
  const effectiveMode = flags.mode ?? rawObj.mode ?? "auto";
  if (effectiveMode === "solo" && (rawObj.planner !== undefined || flags.plan !== undefined)) {
    problems.push({
      field: "planner",
      message: "solo mode runs no planner",
      fix: "remove planner configuration or use plan/auto mode",
    });
  }

  // Settings
  let settings = options.settings;
  if (!settings) {
    try {
      settings = await loadSettings({ projectDir: repoRoot });
    } catch {
      // If settings fail to load, proceed with empty object
      settings = {} as Settings;
    }
  }

  // Provider and Model resolution (Behaviors 5, 6, 7)
  const rolesToCheck: Array<"planner" | "worker"> =
    effectiveMode === "solo" ? ["worker"] : ["planner", "worker"];

  const resolvedRoles: Record<string, { provider: string; model: string; effort?: Effort }> = {};

  for (const role of rolesToCheck) {
    const roleReq = rawObj[role];
    const defaultProvider =
      role === "planner"
        ? settings.defaults?.planner_provider
        : settings.defaults?.worker_provider;
    const provider = roleReq?.provider ?? defaultProvider;

    if (!provider) {
      problems.push({
        field: `${role}.provider`,
        message: `missing provider for ${role}`,
        fix: `pass --${role === "planner" ? "plan" : "work"} <provider> or set defaults.${role}_provider`,
      });
      continue;
    }

    if (!["claude", "opencode", "agy"].includes(provider)) {
      problems.push({
        field: `${role}.provider`,
        message: `invalid provider '${provider}'`,
        fix: `use one of claude, opencode, agy`,
      });
      continue;
    }

    // Effort check
    let effort = roleReq?.effort;
    if (effort !== undefined) {
      if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
        problems.push({
          field: `${role}.effort`,
          message: `invalid effort '${effort}'`,
          fix: "valid efforts: low, medium, high, xhigh, max",
        });
        effort = undefined;
      }
    }

    // Model check
    const explicitModel = roleReq?.model;
    const profileSlot =
      role === "planner"
        ? settings.profiles?.[provider]?.plan?.model
        : settings.profiles?.[provider]?.work?.model;
    const model = explicitModel ?? profileSlot;

    if (!model) {
      problems.push({
        field: `${role}.model`,
        message: `missing model for ${role}`,
        fix: `specify a model or configure profile for ${provider}`,
      });
    } else {
      const catalog = await getCatalog(settings, options);
      const providerEntry = catalog.providers.find((p) => p.provider === provider);
      if (providerEntry && providerEntry.installed) {
        const found = providerEntry.models.some((m) => m.id === model);
        if (!found) {
          const validIds = providerEntry.models.map((m) => m.id).join(", ");
          problems.push({
            field: `${role}.model`,
            message: `unknown model '${model}'`,
            fix: `valid ids: ${validIds}`,
          });
        }
      }
    }

    if (model) {
      resolvedRoles[role] = { provider, model, ...(effort ? { effort } : {}) };
    }
  }

  // Sort problems deterministically by field
  problems.sort((a, b) => a.field.localeCompare(b.field));

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const validRequest = parseResult.data!;

  // Build overrides (Behavior 9)
  const overrides: Record<string, any> = {};
  const plannerRole = resolvedRoles.planner;
  if (plannerRole) {
    overrides.roles = overrides.roles || {};
    overrides.roles.planner = {
      backend: plannerRole.provider,
      model: plannerRole.model,
      ...(plannerRole.effort ? { effort: plannerRole.effort } : {}),
    };
  }
  const workerRole = resolvedRoles.worker;
  if (workerRole) {
    overrides.roles = overrides.roles || {};
    overrides.roles.worker = {
      backend: workerRole.provider,
      model: workerRole.model,
      ...(workerRole.effort ? { effort: workerRole.effort } : {}),
    };
  }
  if (validRequest.budget) {
    overrides.budgets = overrides.budgets || {};
    overrides.budgets.run = overrides.budgets.run || {};
    if (validRequest.budget.max_usd !== undefined) {
      overrides.budgets.run.max_usd = validRequest.budget.max_usd;
    }
    if (validRequest.budget.max_tokens !== undefined) {
      overrides.budgets.run.max_tokens = validRequest.budget.max_tokens;
    }
    if (validRequest.budget.max_wall_min !== undefined) {
      overrides.budgets.run.max_wall_min = validRequest.budget.max_wall_min;
    }
  }
  if (validRequest.verify) {
    overrides.verify = validRequest.verify;
  }
  if (validRequest.context) {
    overrides.context = validRequest.context;
  }

  return {
    ok: true,
    request: validRequest,
    overrides,
    plannerExplicit,
  };
}
