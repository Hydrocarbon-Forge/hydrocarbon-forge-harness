import { assembleSystem, loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";

export interface PlannerPromptOptions {
  request: string;
  repoMap: string;
  instructionFiles?: string[];
  skillsList?: Array<{ name: string; description: string }>;
  /**
   * Remaining `planner/request.md` variables (run_id, base_ref, repo_root,
   * classes, max_tasks, charter, history). A variable
   * the caller does not have is passed as an empty string and renders as
   * `(none)`.
   */
  vars?: Record<string, string>;
}

export interface CorrectionPromptOptions {
  attempt: number;
  max_attempts: number;
  diagnostics: string[];
}

function bullets(items?: string[]): string {
  return (items ?? []).map((item) => `- ${item}`).join("\n");
}

function skills(items?: Array<{ name: string; description: string }>): string {
  return (items ?? []).map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

const REQUEST_VARS: Record<string, string> = {
  run_id: "",
  base_ref: "",
  repo_root: "",
  classes: "",
  max_tasks: "",
  charter: "",
  history: "",
};

export function buildPlannerPrompt(opts: PlannerPromptOptions): {
  system: string;
  user: string;
} {
  const system = assembleSystem("planner", {});
  const user = render(loadTemplate("planner/request.md"), {
    request: opts.request,
    repo_map: opts.repoMap,
    instruction_files: bullets(opts.instructionFiles),
    skills: skills(opts.skillsList),
    ...REQUEST_VARS,
    ...(opts.vars ?? {}),
  });

  return { system, user };
}

export function buildCorrectionPrompt(opts: CorrectionPromptOptions): {
  system: string;
  user: string;
} {
  const system = assembleSystem("planner", {});
  const user = render(loadTemplate("planner/correction.md"), {
    attempt: String(opts.attempt),
    max_attempts: String(opts.max_attempts),
    diagnostics: bullets(opts.diagnostics),
  });

  return { system, user };
}
