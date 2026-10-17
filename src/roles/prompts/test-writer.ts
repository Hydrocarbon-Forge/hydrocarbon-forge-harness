export interface TestWriterPromptOptions {
  specContent: string;
  contractStubs: Array<{ path: string; content: string }>;
}

export function buildTestWriterPrompt(opts: TestWriterPromptOptions): {
  system: string;
  user: string;
} {
  if (!opts.specContent || !opts.specContent.trim()) {
    throw new Error("Missing spec content: specContent must be provided and non-empty");
  }

  if (!opts.contractStubs || opts.contractStubs.length === 0) {
    throw new Error("Missing contract stubs: contractStubs must be non-empty");
  }

  const system = [
    "You are the Substrate test-writer agent.",
    "Your objective is to author comprehensive unit and integration test files satisfying contract interfaces and task acceptance criteria.",
    "",
    "Rules and Constraints:",
    "1. Author test files only. Create tests that verify the task's acceptance criteria and verify commands.",
    "2. Forbid modifying application source code: You must never modify application source code files.",
  ].join("\n");

  const stubsFormatted = opts.contractStubs
    .map(
      (stub) =>
        `### File: ${stub.path}\n\`\`\`ts\n${stub.content}\n\`\`\``,
    )
    .join("\n\n");

  const user = [
    "## Task Specification",
    opts.specContent.trim(),
    "",
    "## Contract Stubs",
    stubsFormatted,
  ].join("\n");

  return { system, user };
}
