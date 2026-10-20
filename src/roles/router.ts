import fs from "node:fs";
import path from "node:path";
import type {
  BackendName,
  Effort,
  Route,
  RoutingDecision,
  Settings,
  TaskClass,
} from "../contracts/index.js";

export interface RouteRequestOptions {
  prompt: string;
  flags?: { mode?: "auto" | "solo" | "plan" };
  settings: Settings;
  repoRoot?: string;
}

// Built-in fallback, the last step of route resolution (after explicit settings and the
// profile slot). It is not a settings default, so a user value is never mistaken for it.
// The solo worker resolves through the same path, so it uses this route too.
export const BUILTIN_FALLBACK_CLASS = "feature";
export const BUILTIN_FALLBACK_ROUTE: Route = {
  backend: "claude",
  model: "claude-sonnet-5-5",
  effort: "medium",
};

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

  // Step 3: Default Fallback
  return {
    mode: "plan",
    planner_route: "default",
    rationale: "Default plan fallback",
  };
}

// Task classes driven by profile slots (DECISIONS A3). A class outside this list
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
// plan order with repeats removed (DECISIONS A3). With no profile configured, the
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

// DECISIONS A3: the planner route comes from the planner provider's plan slot.
// Consumed by the planner spawn in R3.1.
// Precedence (R7.4): the request's planner (roles.requested.planner) wins over the profile
// and roles.planner. Its backend and effort fall back to the base route when unnamed.
export function resolvePlannerRoute(settings: Settings): Route {
  const provider = settings.defaults?.planner_provider;
  const profile = provider !== undefined ? settings.profiles?.[provider] : undefined;

  const base: Route =
    provider !== undefined && profile
      ? buildProfileRoute(provider, profile.plan.model, profile.plan.effort)
      : { ...settings.roles.planner };

  return applyNamed(base, settings.roles.requested?.planner);
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

// Route precedence (known issues item 11; the slots are DECISIONS A3): explicit `routing.<class>`, then
// the worker provider's profile slot for the class (fast falling back to work), then an
// explicit `routing.feature` for any class, then BUILTIN_FALLBACK_ROUTE. The built-in
// route is never a settings default, so every user value above it wins.
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

  return normalizeRoute(BUILTIN_FALLBACK_ROUTE);
}

// The model the caller named for the worker role: the request's worker (R7.4), or in solo
// mode the worker role from settings (which is how --work and --worker-model reached solo
// before R7.4). A named model fixes the route for every generation.
function namedWorker(settings: Settings, solo: boolean): Partial<Route> | undefined {
  const requested = settings.roles.requested?.worker;
  if (requested?.model !== undefined) return requested;
  if (!solo || settings.roles.worker === undefined) return undefined;
  const worker = settings.roles.worker;
  return {
    backend: worker.backend,
    model: worker.model,
    ...(worker.effort !== undefined ? { effort: worker.effort } : {}),
  };
}

// Fills the fields a named route sets; unset fields keep the base route's values.
function applyNamed(base: Route, named: Partial<Route> | undefined): Route {
  if (!named) return base;
  return {
    backend: named.backend ?? base.backend,
    model: named.model ?? base.model,
    ...(named.effort !== undefined
      ? { effort: named.effort }
      : base.effort !== undefined
        ? { effort: base.effort }
        : {}),
  };
}

// The one task-route path (plan tasks, the ladder's replans and the solo worker). Order:
// the base route (routing.<class>, profile slot, routing.feature, built-in), then the
// named worker (request first; in solo mode the worker role), then escalation for
// generations after the first, which is skipped when the worker model is named.
export function resolveTaskRoute(
  taskClass: TaskClass,
  generation: number,
  settings: Settings,
  opts: { solo?: boolean } = {},
): Route {
  const base = baseRouteForClass(taskClass, settings);
  const named = namedWorker(settings, opts.solo === true);
  const pinned = named?.model !== undefined;

  const escalated = pinned || generation <= 1 ? base : escalateRoute(base, generation, settings);
  return applyNamed(escalated, named);
}

function escalateRoute(base: Route, generation: number, settings: Settings): Route {
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
