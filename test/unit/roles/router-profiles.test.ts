import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS, loadSettings, validateProfiles } from "../../../src/config/index.js";
import { evaluateEscalation } from "../../../src/engine/ladder.js";
import type { EngineState } from "../../../src/engine/reducer.js";
import { createRunId } from "../../../src/util/index.js";
import {
  TASK_CLASSES,
  escalationChain,
  resolvePlannerRoute,
  resolveTaskRoute,
  slotForClass,
} from "../../../src/roles/router.js";

// Distinctive fixture ids so a route that came from a profile slot cannot be
// confused with one that came from the default settings.
const CLAUDE_PROFILE: Contracts.Profile = {
  plan: { model: "profile-plan", effort: "max" },
  work: { model: "profile-work", effort: "medium" },
  fast: { model: "profile-fast", effort: "low" },
};

const AGY_PROFILE: Contracts.Profile = {
  plan: { model: "agy-plan", effort: "high" },
  work: { model: "agy-work" },
};

function makeSettings(overrides: Record<string, unknown>): Contracts.Settings {
  return { ...(structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>), ...overrides } as unknown as Contracts.Settings;
}

describe("profile slot mapping (DECISIONS A6)", () => {
  it("maps each task class to its slot", () => {
    const expected: Record<string, "fast" | "work" | "plan"> = {
      search: "fast",
      mechanical: "fast",
      boilerplate: "fast",
      tests: "work",
      feature: "work",
      refactor: "work",
      debug: "plan",
      review: "plan",
    };

    expect([...TASK_CLASSES].sort()).toEqual(Object.keys(expected).sort());

    for (const cls of TASK_CLASSES) {
      expect(slotForClass(cls)).toBe(expected[cls]);
    }
  });

  it("a class outside TASK_CLASSES maps to work", () => {
    expect(slotForClass("docs")).toBe("work");
    expect(slotForClass("")).toBe("work");
  });
});

describe("route precedence (DECISIONS A6)", () => {
  it("an explicit routing entry beats the profile slot", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
      routing: {
        feature: { backend: "claude", model: "explicit-feature", effort: "low" },
        tests: { backend: "claude", model: "explicit-tests", effort: "medium" },
        escalation: ["profile-fast", "profile-work", "profile-plan"],
      },
    });

    expect(resolveTaskRoute("tests", 1, settings)).toEqual({
      backend: "claude",
      model: "explicit-tests",
      effort: "medium",
    });
    expect(resolveTaskRoute("feature", 1, settings)).toEqual({
      backend: "claude",
      model: "explicit-feature",
      effort: "low",
    });
  });

  it("the worker provider slot is used when the class has no routing entry", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
      routing: { escalation: ["profile-fast", "profile-work", "profile-plan"] },
    });

    expect(resolveTaskRoute("mechanical", 1, settings)).toEqual({
      backend: "claude",
      model: "profile-fast",
      effort: "low",
    });
    expect(resolveTaskRoute("review", 1, settings)).toEqual({
      backend: "claude",
      model: "profile-plan",
      effort: "max",
    });
  });

  it("a profile with no fast slot routes search to work", () => {
    const settings = makeSettings({
      profiles: { agy: AGY_PROFILE },
      defaults: { worker_provider: "agy" },
    });

    expect(resolveTaskRoute("search", 1, settings)).toEqual({
      backend: "agy",
      model: "agy-work",
    });
    expect(resolveTaskRoute("boilerplate", 1, settings)).toEqual({
      backend: "agy",
      model: "agy-work",
    });
  });

  it("falls back to the feature route when the class is not configured", () => {
    const settings = makeSettings({
      routing: { feature: { backend: "claude", model: "feature-base", effort: "medium" } },
    });

    expect(resolveTaskRoute("feature", 1, settings)).toEqual({
      backend: "claude",
      model: "feature-base",
      effort: "medium",
    });
    expect(resolveTaskRoute("search", 1, settings)).toEqual({
      backend: "claude",
      model: "feature-base",
      effort: "medium",
    });
  });

  it("throws for a class with no routing entry and no profile", () => {
    const settings = makeSettings({
      routing: { escalation: ["profile-fast", "profile-work", "profile-plan"] },
    });

    expect(() => resolveTaskRoute("feature", 2, settings)).toThrow(
      "no route configured for class 'feature': set routing.<cls> or profiles plus defaults.worker_provider",
    );
  });

  it("never throws for a configured class in TASK_CLASSES", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
      routing: {},
    });

    for (const cls of TASK_CLASSES) {
      for (const generation of [1, 2, 4]) {
        expect(() => resolveTaskRoute(cls, generation, settings)).not.toThrow();
      }
    }
  });
});

describe("escalation chain (DECISIONS A6)", () => {
  it("uses the worker provider slots in fast, work, plan order", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
    });

    expect(escalationChain(settings)).toEqual(["profile-fast", "profile-work", "profile-plan"]);
  });

  it("removes repeats when fast and work name the same model", () => {
    const settings = makeSettings({
      profiles: {
        claude: {
          plan: { model: "solo-plan" },
          work: { model: "shared-model" },
          fast: { model: "shared-model" },
        },
      },
      defaults: { worker_provider: "claude" },
    });

    expect(escalationChain(settings)).toEqual(["shared-model", "solo-plan"]);
  });

  it("uses routing.escalation as the legacy chain when no profile is set", () => {
    const settings = makeSettings({ routing: { escalation: ["a", "b", "c"] } });
    expect(escalationChain(settings)).toEqual(["a", "b", "c"]);

    const noChain = makeSettings({ routing: { feature: { backend: "claude", model: "f" } } });
    expect(escalationChain(noChain)).toEqual([]);
  });

  it("generation 1 uses the base route", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
    });

    expect(resolveTaskRoute("mechanical", 1, settings).model).toBe("profile-fast");
    expect(resolveTaskRoute("mechanical", 0, settings).model).toBe("profile-fast");
  });

  it("generation g moves g-1 steps from the base model position", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
      routing: {},
    });

    expect(resolveTaskRoute("mechanical", 2, settings).model).toBe("profile-work");
    expect(resolveTaskRoute("mechanical", 3, settings).model).toBe("profile-plan");
    expect(resolveTaskRoute("feature", 2, settings).model).toBe("profile-plan");
    expect(resolveTaskRoute("tests", 1, settings).model).toBe("profile-work");
  });

  it("generation past the end of the chain stays on the last model", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
    });

    expect(resolveTaskRoute("mechanical", 6, settings).model).toBe("profile-plan");
    expect(resolveTaskRoute("feature", 6, settings).model).toBe("profile-plan");
  });

  it("a base model that is not in the chain uses index g-1 clamped", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
      routing: {
        tests: { backend: "claude", model: "outside-chain", effort: "low" },
        escalation: ["profile-fast", "profile-work", "profile-plan"],
      },
    });

    expect(resolveTaskRoute("tests", 2, settings).model).toBe("profile-work");
    expect(resolveTaskRoute("tests", 9, settings).model).toBe("profile-plan");
  });

  it("the chain is not consulted when it is empty", () => {
    // A legacy settings file with a feature route and no escalation array: generation 3
    // keeps the base route because there is nothing to move along.
    const settings = makeSettings({ routing: { feature: { backend: "claude", model: "only-work" } } });

    expect(resolveTaskRoute("feature", 3, settings).model).toBe("only-work");
  });
});
describe("resolvePlannerRoute with mixed providers (DECISIONS A3, A5)", () => {
  it("uses the planner provider plan slot", () => {
    const settings = makeSettings({
      profiles: { opencode: AGY_PROFILE, claude: CLAUDE_PROFILE },
      defaults: { planner_provider: "opencode", worker_provider: "claude" },
    });

    expect(resolvePlannerRoute(settings)).toEqual({
      backend: "opencode",
      model: "agy-plan",
      effort: "high",
    });
  });

  it("the worker route uses the worker provider", () => {
    const settings = makeSettings({
      profiles: { opencode: AGY_PROFILE, claude: CLAUDE_PROFILE },
      defaults: { planner_provider: "opencode", worker_provider: "claude" },
      routing: {},
    });

    expect(resolveTaskRoute("feature", 1, settings)).toEqual({
      backend: "claude",
      model: "profile-work",
      effort: "medium",
    });
  });

  it("falls back to roles.planner when no planner provider is named", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { worker_provider: "claude" },
    });

    expect(resolvePlannerRoute(settings)).toEqual(
      expect.objectContaining({ model: DEFAULT_SETTINGS.roles.planner.model }),
    );
  });
});

describe("purity", () => {
  it("the same settings and inputs give the same Route", () => {
    const settings = makeSettings({
      profiles: { claude: CLAUDE_PROFILE },
      defaults: { planner_provider: "claude", worker_provider: "claude" },
    });
    const before = JSON.stringify(settings);

    const first = resolveTaskRoute("feature", 2, settings);
    const second = resolveTaskRoute("feature", 2, settings);
    expect(second).toEqual(first);

    const plannerFirst = resolvePlannerRoute(settings);
    const plannerSecond = resolvePlannerRoute(settings);
    expect(plannerSecond).toEqual(plannerFirst);
    expect(escalationChain(settings)).toEqual(escalationChain(settings));

    expect(JSON.stringify(settings)).toBe(before);
  });
});

describe("loadSettings profile validation (DECISIONS A3)", () => {
  let tempDir: string;

  function useTempDir(): string {
    tempDir = mkdtempSync(join(tmpdir(), "profiles-test-"));
    return tempDir;
  }

  it("throws the validation message when planner_provider has no profile", async () => {
    const projectDir = useTempDir();
    try {
      await expect(
        loadSettings({
          projectDir,
          flags: { defaults: { planner_provider: "agy" } },
        }),
      ).rejects.toThrow(
        'profiles.agy is required because defaults.planner_provider is "agy"',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws the validation message when worker_provider has no profile", async () => {
    const projectDir = useTempDir();
    try {
      await expect(
        loadSettings({
          projectDir,
          userConfigDir: projectDir,
          flags: { defaults: { worker_provider: "agy" } },
        }),
      ).rejects.toThrow(
        'profiles.agy is required because defaults.worker_provider is "agy"',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a default that names a provider with a profile", async () => {
    const projectDir = useTempDir();
    try {
      const settings = await loadSettings({
        projectDir,
        userConfigDir: projectDir,
        flags: {
          profiles: { agy: AGY_PROFILE },
          defaults: { planner_provider: "agy", worker_provider: "agy" },
        },
      });

      expect(settings.profiles?.agy).toEqual(AGY_PROFILE);
      expect(() => validateProfiles(settings)).not.toThrow();
      expect(resolvePlannerRoute(settings).model).toBe("agy-plan");
      expect(resolveTaskRoute("search", 1, settings)).toEqual({ backend: "agy", model: "agy-work" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("validateProfiles does nothing when no default names a provider", () => {
    const settings = makeSettings({ profiles: { claude: CLAUDE_PROFILE } });
    expect(() => validateProfiles(settings)).not.toThrow();
  });
});

describe("the L1 ladder route comes from the profile chain (DECISIONS A6)", () => {
  const profileSettings = Contracts.Settings.parse({
    backends: {},
    roles: { planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" } },
    profiles: { claude: CLAUDE_PROFILE },
    defaults: { worker_provider: "claude" },
    routing: {},
    pricing: { asOf: "2026-10-16", sources: ["https://example.com"], models: {} },
    budgets: {
      run: { max_usd: 10 },
      task: { max_usd: 1.0 },
      l1_replans_per_task: 2,
      l2_per_run: 2,
      planner_format_retries: 2,
      approval_threshold_usd: 2,
    },
    concurrency: { workers: 3 },
    permissions: { allow: [], deny: [] },
    sandbox: { enabled: false },
    git: { on_scope_violation: "revert", auto_merge: false },
    instructions: { workers: "none" },
    execution: { strategy: "direct" },
  });

  function makeState(generation: number): EngineState {
    return {
      run_id: createRunId(),
      state: "EXECUTING",
      tasks: {
        TaskA: { id: "TaskA", state: "VERIFYING", generation, attempt: 2 },
      },
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    } as unknown as EngineState;
  }

  it("the default feature class replans to the plan slot", () => {
    const action = evaluateEscalation(makeState(1), "TaskA", "verify_failed", profileSettings);

    expect(action.level).toBe("L1");
    if (action.level === "L1") {
      expect(action.route).toEqual({ backend: "claude", model: "profile-plan", effort: "medium" });
      expect(action.generation).toBe(2);
    }
  });

  it("a fast class replans from the fast slot to the work slot", () => {
    const action = evaluateEscalation(
      makeState(1),
      "TaskA",
      "verify_failed",
      profileSettings,
      "mechanical",
    );

    expect(action.level).toBe("L1");
    if (action.level === "L1") {
      expect(action.route.model).toBe("profile-work");
    }
  });
});
