import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate } from "./helpers/run-substrate.js";
import { ModelCatalog } from "../../src/cli/model-catalog.js";

// Isolates the user settings layer so results are deterministic on any machine:
// an empty config dir, and empty strings neutralize any inherited overrides.
function isolatedEnv(): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), "substrate-init-doctor-config-"));
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
  };
}

function cleanEnv(env: Record<string, string>): void {
  rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
}

describe("E2E init and doctor", () => {
  it("init writes the settings that differ from defaults, and doctor reads them", () => {
    const env = isolatedEnv();
    try {
      // The ids come from the fake models answer for claude.
      const modelsRun = runSubstrate({
        args: ["models", "--output-format", "json", "--provider", "claude"],
        env,
      });
      let picked: ModelCatalog["all_models"];
      try {
        expect(modelsRun.exitCode).toBe(0);
        const catalog = ModelCatalog.parse(JSON.parse(modelsRun.stdout));
        picked = catalog.providers[0].models;
        expect(picked.length).toBeGreaterThan(2);
        expect(picked[0].provider).toBe("claude");
      } finally {
        modelsRun.cleanup();
      }

      const slotFlags = ["plan", "work", "fast"];
      const slotEfforts = ["medium", "high", "low"];
      const slotArgs: string[] = [];
      picked.slice(0, 3).forEach((model, index) => {
        const effort = model.efforts.includes(slotEfforts[index])
          ? slotEfforts[index]
          : model.efforts[0];
        slotArgs.push(`--${slotFlags[index]}`, `${model.id}:${effort}`);
      });

      // runSubstrate always writes settings.json, so --force is what lets init
      // write the diff in this harness.
      const initRun = runSubstrate({
        args: ["init", "--provider", "claude", ...slotArgs, "--force"],
        env,
      });
      let writtenSettings: Record<string, any>;
      try {
        expect(initRun.exitCode).toBe(0);
        expect(initRun.stdout).toContain("wrote .substrate/settings.json");
        expect(initRun.stdout).toContain("wrote .substrate/.gitignore");
        expect(initRun.stdout).toContain("wrote .substrate/charter.md");

        writtenSettings = JSON.parse(readFileSync(join(initRun.repoDir, ".substrate", "settings.json"), "utf8"));
        expect(Object.keys(writtenSettings).sort()).toEqual(["defaults", "profiles"]);
        expect(writtenSettings.pricing).toBeUndefined();
        expect(writtenSettings.profiles.claude.plan.model).toBe(picked[0].id);
        expect(writtenSettings.defaults).toEqual({
          planner_provider: "claude",
          worker_provider: "claude",
        });

        const gitignore = readFileSync(join(initRun.repoDir, ".substrate", ".gitignore"), "utf8");
        expect(gitignore.split("\n").filter((line) => line.length > 0)).toEqual([
          "runs/",
          "worktrees/",
          "state/",
          "sessions/",
          "ledger/",
          "settings.local.json",
        ]);
        expect(gitignore).not.toMatch(/archive/);

        const charter = readFileSync(join(initRun.repoDir, ".substrate", "charter.md"), "utf8");
        expect(charter.startsWith("# Charter")).toBe(true);
        expect(charter).toMatch(/planner/);

        const exclude = readFileSync(join(initRun.repoDir, ".git", "info", "exclude"), "utf8");
        expect(exclude).not.toContain(".substrate");
      } finally {
        initRun.cleanup();
      }

      // Doctor reads the settings init wrote. The same profiles and defaults are
      // seeded so the fake executables still answer for the providers.
      const doctorRun = runSubstrate({
        args: ["doctor", "--output-format", "json"],
        env,
        settings: { profiles: writtenSettings.profiles, defaults: writtenSettings.defaults },
      });
      try {
        expect(doctorRun.exitCode).toBe(0);
        const report = JSON.parse(doctorRun.stdout);
        expect(Object.keys(report)).toEqual(["node", "git", "bubblewrap", "adapters", "checks"]);
        expect(report.node.ok).toBe(true);
        expect(report.git.ok).toBe(true);
        expect(report.adapters.claude).toBe("2.1.301");
        expect(report.checks.some((check: any) => check.status === "FAIL")).toBe(false);
        const profilesCheck = report.checks.find((check: any) => check.name === "profiles.claude");
        expect(profilesCheck.status).toBe("PASS");
        expect(profilesCheck.detail).toContain(picked[0].id);
      } finally {
        doctorRun.cleanup();
      }

      // A profile model the provider does not list is WARN, not FAIL, so exit stays 0.
      const warnRun = runSubstrate({
        args: ["doctor"],
        env,
        settings: {
          profiles: { claude: { plan: { model: "not-a-model", effort: "medium" }, work: { model: "opus" } } },
        },
      });
      try {
        expect(warnRun.exitCode).toBe(0);
        expect(warnRun.stdout).toMatch(/^\[PASS\] node: /m);
        expect(warnRun.stdout).toMatch(/^\[PASS\] git: /m);
        expect(warnRun.stdout).toMatch(/^\[WARN\] profiles\.claude: plan=not-a-model not listed by claude$/m);
        expect(warnRun.stdout).toMatch(/^  fix: choose a model claude lists: /m);
      } finally {
        warnRun.cleanup();
      }
    } finally {
      cleanEnv(env);
    }
  });
});
