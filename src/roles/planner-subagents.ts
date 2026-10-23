import type { Settings, SpawnRequest } from "../contracts/index.js";
import { loadTemplate } from "../prompts/index.js";
import { resolveTaskRoute } from "./router.js";

const PLANNER_DENY = ["git commit", "git push", "git checkout", "git reset"];

/**
 * The deny list and subagents of a planner spawn (DECISIONS A1). The claude harness
 * starts one read-only `explorer` subagent on the worker's search route. Other harnesses
 * have no subagents, so their planners keep `subagents` denied.
 */
export function plannerSubagentsOf(
  settings: Settings,
  plannerBackend: string,
): { deny: string[]; subagents?: NonNullable<SpawnRequest["subagents"]> } {
  if (plannerBackend !== "claude") {
    return { deny: [...PLANNER_DENY, "subagents"] };
  }

  const prompt = loadTemplate("planner/explorer.md");
  const description = prompt.split("\n")[0].trim();
  const model = resolveTaskRoute("search", 1, settings).model;

  return {
    deny: [...PLANNER_DENY],
    subagents: [{ name: "explorer", description, prompt, model }],
  };
}
