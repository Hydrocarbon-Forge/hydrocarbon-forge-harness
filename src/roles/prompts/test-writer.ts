import { assembleSystem, loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";

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

  return {
    system: assembleSystem("test-writer", {}),
    user: render(loadTemplate("test-writer/task.md"), { spec_path: "" }),
  };
}
