import fs from "node:fs";
import path from "node:path";
import type {
  BackendName,
  Effort,
  Route,
  RoutingDecision,
  RunId,
  Settings,
  TaskClass,
  TaskId,
} from "../contracts/index.js";
import { checkGovernorHealth, callGovernorIntake } from "./governor.js";

export interface RouteRequestOptions {
  prompt: string;
  flags?: { mode?: "auto" | "solo" | "plan"; noGovernor?: boolean };
  settings: Settings;
  repoRoot?: string;
}

export interface RouteOutcomeRecord {
  run_id: RunId;
  task_id?: TaskId;
  decision: RoutingDecision;
  rule_matched: "flag" | "deterministic" | "governor" | "fallback";
  outcome?: "passed" | "failed" | "healed" | "replanned";
  cost_usd?: number;
  duration_ms?: number;
  timestamp: string;
}

const MECHANICAL_VERBS = [
  "update dependency",
  "fix typo",
  "rename",
  "move",
  "delete",
  "remove",
  "bump",
  "format",
  "typo",
];

export async function routeRequest(opts: RouteRequestOptions): Promise<RoutingDecision> {
  // Step 1: Explicit Flags
  if (opts.flags?.mode === "solo") {
    return {
      mode: "solo",
      rationale: "Explicit --mode solo flag",
    };
  }
  if (opts.flags?.mode === "plan") {
    return {
      mode: "plan",
      rationale: "Explicit --mode plan flag",
    };
  }

  // Step 2: Deterministic Rules (Named single existing file + mechanical verb)
  const hasMechanicalVerb = MECHANICAL_VERBS.some((verb) =>
    new RegExp(`\\b${verb.replace(/\s+/g, "\\s+")}\\b`, "i").test(opts.prompt),
  );

  if (hasMechanicalVerb) {
    const tokens = opts.prompt.split(/[\s,;:"'()\[\]{}]+/).filter(Boolean);
    const existingFiles = new Set<string>();

    if (opts.repoRoot && fs.existsSync(opts.repoRoot)) {
      for (const token of tokens) {
        try {
          const full = path.join(opts.repoRoot, token);
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            existingFiles.add(token);
          }
        } catch {
          // ignore stat errors
        }
      }
    }

    const fileLikeTokens = tokens.filter((t) => /\.[a-zA-Z0-9_-]+$/.test(t));

    if (existingFiles.size === 1 && fileLikeTokens.length <= 1) {
      return {
        mode: "solo",
        task_class: "mechanical",
        rationale: "Deterministic match: single file with mechanical verb",
      };
    }
  }

  // Step 3: Governor LLM
  if (!opts.flags?.noGovernor && opts.settings.roles?.governor?.enabled) {
    const gov = opts.settings.roles.governor;
    if (gov.endpoint) {
      const timeoutMs = (gov.timeout_s ?? 10) * 1000;
      const isHealthy = await checkGovernorHealth(gov.endpoint, timeoutMs);
      if (isHealthy) {
        try {
          const intake = await callGovernorIntake(opts.prompt, {
            endpoint: gov.endpoint,
            model: gov.model,
            timeoutMs,
            enableThinking: false,
          });

          if (intake.decision) {
            return intake.decision;
          }

          const startRun = intake.toolCalls.find((t) => t.name === "start_run");
          if (startRun && startRun.name === "start_run") {
            return {
              mode: startRun.args.mode ?? "plan",
              rationale: `Governor routed via start_run: ${startRun.args.request}`,
            };
          }
        } catch {
          // Fall through smoothly to default plan fallback
        }
      }
    }
  }

  // Step 4: Default Fallback
  return {
    mode: "plan",
    planner_route: "default",
    rationale: "Default plan fallback",
  };
}

// Task classes driven by profile slots (DECISIONS A6). A class outside this list
// behaves as "work".
export const TASK_CLASSES = [
  "search",
  "mechanical",
  "boilerplate",
  "tests",
  "feature",
  "refactor",
  "debug",
  "review",
] as const;

export function slotForClass(cls: string): "fast" | "work" | "plan" {
  if (!(TASK_CLASSES as readonly string[]).includes(cls)) {
    return "work";
  }
  switch (cls) {
    case "search":
    case "mechanical":
    case "boilerplate":
      return "fast";
    case "debug":
    case "review":
      return "plan";
    default:
      return "work";
  }
}

// The chain generation escalation walks: the worker provider's slots in fast, work,
// plan order with repeats removed (DECISIONS A6). With no profile configured, the
// legacy `routing.escalation` array is the chain.
export function escalationChain(settings: Settings): string[] {
  const provider = settings.defaults?.worker_provider;
  const profile = provider !== undefined ? settings.profiles?.[provider] : undefined;

  if (profile) {
    const chain: string[] = [];
    for (const model of [profile.fast?.model, profile.work.model, profile.plan.model]) {
      if (model !== undefined && !chain.includes(model)) {
        chain.push(model);
      }
    }
    return chain;
  }

  const legacy = settings.routing.escalation;
  return Array.isArray(legacy) ? [...legacy] : [];
}

// DECISIONS A3, A6: the planner route comes from the planner provider's plan slot.
// Consumed by the planner spawn in R3.1.
export function resolvePlannerRoute(settings: Settings): Route {
  const provider = settings.defaults?.planner_provider;
  const profile = provider !== undefined ? settings.profiles?.[provider] : undefined;

  if (provider !== undefined && profile) {
    return buildProfileRoute(provider, profile.plan.model, profile.plan.effort);
  }

  return { ...settings.roles.planner };
}

// BackendName is a closed enum, so a dynamic provider name from settings.profiles is
// a cast, not a new value.
function buildProfileRoute(provider: string, model: string, effort?: Effort): Route {
  const route: Route = { backend: provider as BackendName, model };
  if (effort !== undefined) {
    route.effort = effort;
  }
  return route;
}

function isRouteEntry(value: unknown): value is Route {
  return typeof value === "object" && value !== null && "backend" in value && "model" in value;
}

function normalizeRoute(route: Route): Route {
  return buildProfileRoute(route.backend, route.model, route.effort);
}

// Route precedence (DECISIONS A6): explicit `routing.<class>`, then the worker
// provider's profile slot for the class (fast falling back to work), then the feature
// route. The hard-coded model fallback is removed, so an unconfigured class throws.
function baseRouteForClass(taskClass: string, settings: Settings): Route {
  const routing = settings.routing as Record<string, unknown>;

  const direct = routing[taskClass];
  if (isRouteEntry(direct)) {
    return normalizeRoute(direct as Route);
  }

  const provider = settings.defaults?.worker_provider;
  const profile = provider !== undefined ? settings.profiles?.[provider] : undefined;
  if (provider !== undefined && profile) {
    const slot = slotForClass(taskClass);
    if (slot === "plan") {
      return buildProfileRoute(provider, profile.plan.model, profile.plan.effort);
    }
    if (slot === "fast" && profile.fast) {
      return buildProfileRoute(provider, profile.fast.model, profile.fast.effort);
    }
    return buildProfileRoute(provider, profile.work.model, profile.work.effort);
  }

  const feature = routing.feature;
  if (isRouteEntry(feature)) {
    return normalizeRoute(feature as Route);
  }

  throw new Error(
    `no route configured for class '${taskClass}': set routing.<cls> or profiles plus defaults.worker_provider`,
  );
}

export function resolveTaskRoute(
  taskClass: TaskClass,
  generation: number,
  settings: Settings,
): Route {
  const base = baseRouteForClass(taskClass, settings);

  if (generation <= 1) {
    return base;
  }

  const chain = escalationChain(settings);
  if (chain.length === 0) {
    return base;
  }

  const baseIdx = chain.indexOf(base.model);
  const targetIdx =
    baseIdx !== -1
      ? Math.min(baseIdx + (generation - 1), chain.length - 1)
      : Math.min(generation - 1, chain.length - 1);

  return buildProfileRoute(base.backend, chain[targetIdx] ?? base.model, base.effort);
}

export async function appendRouteOutcome(
  record: RouteOutcomeRecord,
  ledgerDir = ".substrate/ledger",
): Promise<void> {
  await fs.promises.mkdir(ledgerDir, { recursive: true });
  const ledgerFile = path.join(ledgerDir, "routes.jsonl");
  await fs.promises.appendFile(ledgerFile, JSON.stringify(record) + "\n", "utf8");
}
