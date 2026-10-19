import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { runSubstrate } from "./helpers/run-substrate.js";
import { ModelCatalog } from "../../src/cli/model-catalog.js";

// Isolates the user settings layer so results are deterministic on any machine:
// an empty config dir, and empty strings neutralize any inherited overrides.
function isolatedEnv(): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), "substrate-profiles-config-"));
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

// The catalog is built from settings roles, routing and the price table, so the profile
// slot ids are distinctive and priced: their presence in the output proves the run read
// them from the seeded settings file.
const SLOT_IDS = ["profile-plan-slot-model", "profile-work-slot-model", "profile-fast-slot-model"];

function pricedModels(): Record<string, { input_per_mtok: number; output_per_mtok: number }> {
  const models: Record<string, { input_per_mtok: number; output_per_mtok: number }> = {};
  for (const id of SLOT_IDS) {
    models[id] = { input_per_mtok: 1, output_per_mtok: 5 };
  }
  return models;
}

describe("E2E profiles and routing defaults", () => {
  it("models lists each profile slot model through the settings gate", () => {
    const env = isolatedEnv();
    try {
      const res = runSubstrate({
        args: ["models", "--output-format", "json"],
        env,
        settings: {
          profiles: {
            claude: {
              plan: { model: SLOT_IDS[0], effort: "max" },
              work: { model: SLOT_IDS[1], effort: "medium" },
              fast: { model: SLOT_IDS[2], effort: "low" },
            },
          },
          defaults: { planner_provider: "claude", worker_provider: "claude" },
          pricing: { asOf: "2026-10-16", sources: ["https://example.com"], models: pricedModels() },
        },
      });

      try {
        expect(res.exitCode).toBe(0);

        for (const id of SLOT_IDS) {
          expect(res.stdout).toContain(id);
        }

        const catalog = ModelCatalog.parse(JSON.parse(res.stdout));
        const ids = catalog.all_models.map((model) => model.id);
        for (const id of SLOT_IDS) {
          expect(ids).toContain(id);
        }
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });

  it("a default that names a provider without a profile exits 2 with the validation message", () => {
    const env = isolatedEnv();
    try {
      // `config` maps a loadSettings failure to exit 2, so this is the path that shows the
      // validation message on stderr. `models` does not catch the failure itself and exits 1.
      const res = runSubstrate({
        args: ["config", "get", "defaults"],
        env,
        settings: {
          profiles: {
            claude: {
              plan: { model: "profile-plan-slot-model", effort: "max" },
              work: { model: "profile-work-slot-model", effort: "medium" },
            },
          },
          defaults: { worker_provider: "agy" },
        },
      });

      try {
        expect(res.exitCode).toBe(2);
        expect(res.stderr).toContain(
          'profiles.agy is required because defaults.worker_provider is "agy"',
        );
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });

  it("a configured profile is accepted and shown by config get", () => {
    const env = isolatedEnv();
    try {
      const res = runSubstrate({
        args: ["config", "get", "profiles"],
        env,
        settings: {
          profiles: {
            agy: {
              plan: { model: "agy-profile-plan-model", effort: "high" },
              work: { model: "agy-profile-work-model" },
            },
          },
          defaults: { planner_provider: "agy", worker_provider: "agy" },
        },
      });

      try {
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("agy-profile-plan-model");
      } finally {
        res.cleanup();
        rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(env.SUBSTRATE_CONFIG_DIR, { recursive: true, force: true });
      throw err;
    }
  });
});
