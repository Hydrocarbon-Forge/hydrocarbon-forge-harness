import { assembleSystem, loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";

export function buildReviewerPrompt(
  diff: string,
  contracts: string[],
): {
  system: string;
  user: string;
} {
  const system = assembleSystem("reviewer", {});
  const user = render(loadTemplate("reviewer/review.md"), {
    task_specs: "",
    contracts: contracts.length > 0 ? contracts.map((c) => `- ${c}`).join("\n") : "",
    diff,
  });

  return { system, user };
}
