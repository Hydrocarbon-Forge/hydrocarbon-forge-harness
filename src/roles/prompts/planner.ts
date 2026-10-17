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
  const system = [
    "You are the Substrate planner agent.",
    "Your objective is to decompose the user's request into a structured execution plan.",
    "",
    "Rules and Requirements:",
    "1. Author `manifest.yaml` specifying ecosystem, setup commands, contracts, integration_verify commands, and the list of tasks.",
    "2. Author individual task specs into the tasks/ directory. Each task spec must contain YAML frontmatter and the following required Markdown headings:",
    "   - ## Objective",
    "   - ## Interface",
    "   - ## Behavior",
    "   - ## Invariants",
    "   - ## Edge cases",
    "   - ## Guardrails",
    "   - ## Out of scope",
    "3. Author typed contract stubs corresponding to interfaces under contracts/.",
    "4. Strictly forbidden: Do not author implementation bodies in task specs or contract stubs. Declare only signatures, schemas, and type declarations.",
  ].join("\n");

  const userSections: string[] = [];

  userSections.push(`## User Request\n${opts.request}`);

  const repoMapContent =
    opts.repoMap && opts.repoMap.trim().length > 0
      ? opts.repoMap.trim()
      : "(Repository map is empty; no files found)";
  userSections.push(`## Repository Map\n${repoMapContent}`);

  if (opts.instructionFiles && opts.instructionFiles.length > 0) {
    userSections.push(
      `## Instruction Files\n${opts.instructionFiles.map((f) => `- ${f}`).join("\n")}`,
    );
  }

  if (opts.skillsList && opts.skillsList.length > 0) {
    userSections.push(
      `## Skills\n${opts.skillsList.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`,
    );
  }

  return {
    system,
    user: userSections.join("\n\n"),
  };
}
