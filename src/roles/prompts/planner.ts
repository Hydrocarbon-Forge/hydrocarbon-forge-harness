import { assembleSystem, loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";

export interface PlannerPromptOptions {
  request: string;
  repoMap: string;
  instructionFiles?: string[];
  skillsList?: Array<{ name: string; description: string }>;
}

export function buildPlannerPrompt(opts: PlannerPromptOptions): {
  system: string;
  user: string;
} {
  const system = assembleSystem("planner", {});
  const user = render(loadTemplate("planner/request.md"), {
    request: opts.request,
    repo_map: opts.repoMap,
    instruction_files: opts.instructionFiles
      ? opts.instructionFiles.map((f) => `- ${f}`).join("\n")
      : "",
    skills: opts.skillsList
      ? opts.skillsList.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "",
    run_id: "",
    base_ref: "",
    repo_root: "",
    classes: "",
    task_budget: "",
    run_budget: "",
    max_tasks: "",
    charter: "",
    history: "",
  });

  return { system, user };
}
