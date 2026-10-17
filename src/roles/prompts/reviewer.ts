export function buildReviewerPrompt(
  diff: string,
  contracts: string[],
): {
  system: string;
  user: string;
} {
  const system = [
    "You are the Substrate reviewer agent.",
    "Your objective is to review and verify patch diffs against contract specifications, scope isolation, and repository invariants.",
    "",
    "Rules and Review Criteria:",
    "1. Review the patch diff thoroughly against all declared contracts.",
    "2. Verify scope isolation: ensure changes only touch files allowed by the task specification.",
    "3. Check that repository invariants and acceptance criteria are satisfied.",
    "4. Emit a structured review report containing your verdict (PASS or FAIL), invariant checks, scope verification, and rationale.",
  ].join("\n");

  const contractsSection =
    contracts.length > 0
      ? `## Contract Files\n${contracts.map((c) => `- ${c}`).join("\n")}`
      : "## Contract Files\n(No contracts specified)";

  const user = [
    contractsSection,
    "",
    "## Patch Diff",
    "```diff",
    diff,
    "```",
    "",
    "Please provide your structured review report and verdict.",
  ].join("\n");

  return { system, user };
}
