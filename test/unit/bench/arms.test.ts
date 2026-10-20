import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import type { ArmConfig, BenchmarkArm, BenchmarkRunConfig } from "../../../bench/types.js";
import { resolveArmConfig } from "../../../bench/arms.js";

function makeSettings(overrides: Partial<Contracts.Settings> = {}): Contracts.Settings {
  return Contracts.Settings.parse({
    backends: {
      claude: { bin: "claude", version_pin: "1.0.0" },
      opencode: { bin: "opencode", version_pin: "1.0.0" },
    },
    roles: {
      planner: { backend: "claude", model: "claude-opus-5-5", effort: "high" },
    },
    routing: {
      mechanical: { backend: "claude", model: "claude-haiku-5-5", effort: "low" },
      boilerplate: { backend: "claude", model: "claude-haiku-5-5", effort: "low" },
      feature: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      debug: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      refactor: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      tests: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      escalation: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    },
    pricing: {
      asOf: "2026-10-16",
      sources: ["https://example.com"],
      models: {
        "claude-opus-5-5": { input_per_mtok: 15, output_per_mtok: 75 },
        "claude-haiku-5-5": { input_per_mtok: 0.25, output_per_mtok: 1.25 },
        "claude-sonnet-5-5": { input_per_mtok: 3, output_per_mtok: 15 },
      },
    },
    budgets: {
      run: { max_usd: 10 },
      task: { max_usd: 2.0 },
      l1_replans_per_task: 2,
      l2_per_run: 2,
      planner_format_retries: 2,
      approval_threshold_usd: 2,
    },
    concurrency: { workers: 3 },
    permissions: { allow: [], deny: [] },
    sandbox: { enabled: true },
    git: { on_scope_violation: "revert", auto_merge: false },
    instructions: { workers: "none" },
    execution: { strategy: "direct" },
    ...overrides,
  });
}

describe("Benchmark Arm configuration and resolution (P6.3 §13)", () => {
  const baseRunConfig: BenchmarkRunConfig = {
    repetitions: 3,
  };

  describe("Resolution of Arm A (Solo top-tier model, high effort)", () => {
    it("resolves Arm A to solo mode with high effort and planner model from settings", () => {
      const settings = makeSettings();
      const config = resolveArmConfig("A", settings, baseRunConfig);

      expect(config.arm).toBe("A");
      expect(config.mode).toBe("solo");
      expect(config.effort).toBe("high");
      expect(config.model).toBe("claude-opus-5-5");
      expect(config.backend).toBe("claude");
      expect(config.routeOverrides).toBeUndefined();
    });

    it("overrides Arm A model when config.topModel is provided", () => {
      const settings = makeSettings();
      const runConfig: BenchmarkRunConfig = {
        ...baseRunConfig,
        topModel: "claude-opus-custom",
      };

      const config = resolveArmConfig("A", settings, runConfig);
      expect(config.model).toBe("claude-opus-custom");
      expect(config.mode).toBe("solo");
      expect(config.effort).toBe("high");
    });
  });

  describe("Resolution of Arm B (Solo cheap-tier model, low effort)", () => {
    it("resolves Arm B to solo mode with low effort and mechanical model from settings", () => {
      const settings = makeSettings();
      const config = resolveArmConfig("B", settings, baseRunConfig);

      expect(config.arm).toBe("B");
      expect(config.mode).toBe("solo");
      expect(config.effort).toBe("low");
      expect(config.model).toBe("claude-haiku-5-5");
      expect(config.backend).toBe("claude");
      expect(config.routeOverrides).toBeUndefined();
    });

    it("overrides Arm B model when config.cheapModel is provided", () => {
      const settings = makeSettings();
      const runConfig: BenchmarkRunConfig = {
        ...baseRunConfig,
        cheapModel: "gpt-4o-mini-custom",
      };

      const config = resolveArmConfig("B", settings, runConfig);
      expect(config.model).toBe("gpt-4o-mini-custom");
      expect(config.mode).toBe("solo");
      expect(config.effort).toBe("low");
    });
  });

  describe("Resolution of Arm C (Substrate default plan mode)", () => {
    it("resolves Arm C to plan mode utilizing default multi-agent routing table", () => {
      const settings = makeSettings();
      const config = resolveArmConfig("C", settings, baseRunConfig);

      expect(config.arm).toBe("C");
      expect(config.mode).toBe("plan");
      expect(config.model).toBe(settings.roles.planner.model);
      // Arm C has no local worker overrides
      expect(config.routeOverrides).toBeFalsy();
    });
  });

  describe("Resolution of Arm D (Substrate plan mode with local-model workers)", () => {
    it("resolves Arm D to plan mode with overrides for mechanical and boilerplate tasks to opencode local model", () => {
      const settings = makeSettings();
      const config = resolveArmConfig("D", settings, baseRunConfig);

      expect(config.arm).toBe("D");
      expect(config.mode).toBe("plan");
      expect(config.routeOverrides).toBeDefined();

      const overrides = config.routeOverrides!;
      expect(overrides.mechanical).toBeDefined();
      expect(overrides.boilerplate).toBeDefined();

      expect(overrides.mechanical.backend).toBe("opencode");
      expect(overrides.boilerplate.backend).toBe("opencode");

      // Preserves default routing for other task classes (not overridden)
      expect(overrides.feature).toBeUndefined();
      expect(overrides.debug).toBeUndefined();
      expect(overrides.refactor).toBeUndefined();
      expect(overrides.tests).toBeUndefined();
    });

    it("overrides Arm D local model when config.localModel is provided", () => {
      const settings = makeSettings();
      const runConfig: BenchmarkRunConfig = {
        ...baseRunConfig,
        localModel: "qwen2.5-coder-7b-instruct",
      };

      const config = resolveArmConfig("D", settings, runConfig);
      const overrides = config.routeOverrides!;

      expect(overrides.mechanical.model).toBe("qwen2.5-coder-7b-instruct");
      expect(overrides.boilerplate.model).toBe("qwen2.5-coder-7b-instruct");
    });
  });

  describe("Invariant I5: Models are explicit (no implicit fallbacks)", () => {
    it("throws descriptive error when resolving Arm A if no model is declared or configured", () => {
      // Construct settings without planner role model
      const settings = makeSettings();
      const malformedSettings = {
        ...settings,
        roles: {
          ...settings.roles,
          planner: { ...settings.roles.planner, model: "" },
        },
      } as unknown as Contracts.Settings;

      expect(() =>
        resolveArmConfig("A", malformedSettings, { repetitions: 1 })
      ).toThrow(/model/i);
    });

    it("throws descriptive error when resolving Arm B if mechanical route model is missing", () => {
      const settings = makeSettings();
      const malformedSettings = {
        ...settings,
        routing: {
          ...settings.routing,
          mechanical: undefined,
        },
      } as unknown as Contracts.Settings;

      expect(() =>
        resolveArmConfig("B", malformedSettings, { repetitions: 1 })
      ).toThrow(/mechanical|model/i);
    });

    it("throws error when unknown arm identifier is provided", () => {
      const settings = makeSettings();
      expect(() =>
        resolveArmConfig("E" as BenchmarkArm, settings, baseRunConfig)
      ).toThrow(/unknown|invalid/i);
    });
  });
});
