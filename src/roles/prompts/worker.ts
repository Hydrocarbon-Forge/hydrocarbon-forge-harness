import path from "node:path";

import { assembleSystem, loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";

export function buildWorkerPrompt(specAbsPath: string): {
  system: string;
  user: string;
} {
  if (!specAbsPath || typeof specAbsPath !== "string" || !path.isAbsolute(specAbsPath)) {
    throw new Error(`specAbsPath must be an absolute path: received "${specAbsPath}"`);
  }

  return {
    system: assembleSystem("worker", {}),
    user: render(loadTemplate("worker/task.md"), { spec_path: specAbsPath }),
  };
}
