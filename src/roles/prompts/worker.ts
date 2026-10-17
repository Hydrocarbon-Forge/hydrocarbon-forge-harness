import path from "node:path";

export function buildWorkerPrompt(specAbsPath: string): {
  system: string;
  user: string;
} {
  if (!specAbsPath || typeof specAbsPath !== "string" || !path.isAbsolute(specAbsPath)) {
    throw new Error(`specAbsPath must be an absolute path: received "${specAbsPath}"`);
  }

  return {
    system: "You are an unattended worker executing a task spec.",
    user: `Execute the task spec at ${specAbsPath}. Work only in the current directory. Do not run git commit/push/checkout/reset. Reply with one line: DONE or BLOCKED: <reason>.`,
  };
}
