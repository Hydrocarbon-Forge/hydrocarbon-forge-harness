import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Global setup for Vitest E2E tests: bundles the CLI once before any test file runs.
 */
export default async function setup(): Promise<void> {
  const projectRoot = resolve(__dirname, "../..");
  execFileSync(process.execPath, [resolve(projectRoot, "scripts/bundle.mjs")], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}
