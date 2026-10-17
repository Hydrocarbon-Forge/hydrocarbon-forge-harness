import fs from "node:fs";
import path from "node:path";
import type {
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

export function resolveTaskRoute(
  taskClass: TaskClass,
  generation: number,
  settings: Settings,
): Route {
  const routing = settings.routing as Record<string, unknown>;
  const baseRaw = routing[taskClass] ?? routing["feature"];

  let baseRoute: Route;
  if (baseRaw && typeof baseRaw === "object" && "backend" in baseRaw && "model" in baseRaw) {
    baseRoute = {
      backend: (baseRaw as Route).backend,
      model: (baseRaw as Route).model,
      effort: (baseRaw as Route).effort,
    };
  } else {
    baseRoute = {
      backend: "claude",
      model: "claude-sonnet-5-5",
      effort: "medium",
    };
  }

  if (generation <= 1) {
    return { ...baseRoute };
  }

  const escalation = Array.isArray(routing.escalation)
    ? (routing.escalation as string[])
    : [];

  if (escalation.length === 0) {
    return { ...baseRoute };
  }

  const currentIdx = escalation.indexOf(baseRoute.model);
  let targetIdx: number;
  if (currentIdx !== -1) {
    targetIdx = Math.min(currentIdx + (generation - 1), escalation.length - 1);
  } else {
    targetIdx = Math.min(generation - 1, escalation.length - 1);
  }

  const escalatedModel = escalation[targetIdx] ?? baseRoute.model;
  return {
    backend: baseRoute.backend,
    model: escalatedModel,
    effort: baseRoute.effort,
  };
}

export async function appendRouteOutcome(
  record: RouteOutcomeRecord,
  ledgerDir = ".substrate/ledger",
): Promise<void> {
  await fs.promises.mkdir(ledgerDir, { recursive: true });
  const ledgerFile = path.join(ledgerDir, "routes.jsonl");
  await fs.promises.appendFile(ledgerFile, JSON.stringify(record) + "\n", "utf8");
}
