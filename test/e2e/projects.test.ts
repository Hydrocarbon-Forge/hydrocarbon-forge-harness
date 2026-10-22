import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2ERepo } from "./helpers/repo.js";
import { runSubstrate } from "./helpers/run-substrate.js";

// The project registry, end to end (web-ui design, section 6.1): `init` registers a project, and
// `runs --all-projects` lists the runs of every registered project. Each repo carries one seeded run
// journal, so the listing has rows to name the project of.

// Isolates the user state directory: the registry lives under XDG_STATE_HOME, never the real home.
function isolatedEnv(): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), "substrate-projects-config-"));
  const stateDir = mkdtempSync(join(tmpdir(), "substrate-projects-state-"));
  return {
    SUBSTRATE_CONFIG_DIR: configDir,
    SUBSTRATE_SETTINGS: "",
    SUBSTRATE_PROJECT_DIR: "",
    SUBSTRATE_MODEL: "",
    SUBSTRATE_WORKER_MODEL: "",
    SUBSTRATE_OUTPUT_FORMAT: "",
    SUBSTRATE_EXECUTION: "",
    SUBSTRATE_SETTINGS_CONTENT: "",
    SUBSTRATE_PERMISSION_MODE: "",
    XDG_STATE_HOME: stateDir,
  };
}

// One seeded run per repo: a journal with its run.created event, which is all `runs` reads.
function seededRun(runId: string, prompt: string): Record<string, string> {
  const event = {
    v: 1,
    seq: 1,
    ts: "2026-10-20T10:00:00.000Z",
    run_id: runId,
    type: "run.created",
    data: { prompt },
  };
  return { [`.substrate/runs/${runId}/events.jsonl`]: JSON.stringify(event) + "\n" };
}

const ALPHA_RUN = "r_ALPHAPROJECT01";
const BETA_RUN = "r_BETAPROJECT02";

describe("E2E project registry", () => {
  it("init in two repos registers both, and runs --all-projects lists both projects' runs", () => {
    const env = isolatedEnv();
    const alpha = createE2ERepo(seededRun(ALPHA_RUN, "alpha work"));
    const beta = createE2ERepo(seededRun(BETA_RUN, "beta work"));
    const results: Array<{ cleanup(): void }> = [];
    try {
      const initAlpha = runSubstrate({ repo: alpha, args: ["init"], env });
      const initBeta = runSubstrate({ repo: beta, args: ["init"], env });
      results.push(initAlpha, initBeta);
      expect(initAlpha.exitCode).toBe(0);
      expect(initBeta.exitCode).toBe(0);

      const listed = runSubstrate({ repo: alpha, args: ["runs", "--all-projects", "--output-format", "json"], env });
      results.push(listed);
      expect(listed.exitCode).toBe(0);
      const rows = JSON.parse(listed.stdout) as Array<{ run_id: string; project: string; project_name: string }>;
      expect(rows.map((r) => r.run_id).sort()).toEqual([ALPHA_RUN, BETA_RUN].sort());
      expect(rows.find((r) => r.run_id === ALPHA_RUN)).toMatchObject({
        project: realpathSync(alpha.dir),
        project_name: alpha.dir.split("/").pop(),
      });
      expect(rows.find((r) => r.run_id === BETA_RUN)?.project).toBe(realpathSync(beta.dir));
    } finally {
      results.forEach((r) => r.cleanup());
      alpha.cleanup();
      beta.cleanup();
      rmSync(env.XDG_STATE_HOME, { recursive: true, force: true });
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
    }
  });

  it("a project whose directory is deleted disappears from the --all-projects listing", () => {
    const env = isolatedEnv();
    const alpha = createE2ERepo(seededRun(ALPHA_RUN, "alpha work"));
    const beta = createE2ERepo(seededRun(BETA_RUN, "beta work"));
    const results: Array<{ cleanup(): void }> = [];
    try {
      results.push(runSubstrate({ repo: alpha, args: ["init"], env }));
      results.push(runSubstrate({ repo: beta, args: ["init"], env }));

      beta.cleanup();

      const listed = runSubstrate({ repo: alpha, args: ["runs", "--all-projects", "--output-format", "json"], env });
      results.push(listed);
      expect(listed.exitCode).toBe(0);
      const rows = JSON.parse(listed.stdout) as Array<{ run_id: string }>;
      expect(rows.map((r) => r.run_id)).toEqual([ALPHA_RUN]);
    } finally {
      results.forEach((r) => r.cleanup());
      alpha.cleanup();
      rmSync(env.XDG_STATE_HOME, { recursive: true, force: true });
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
    }
  });
});
