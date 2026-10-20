import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS, assertNoRequestedRolesInFiles, withRequestedRoles } from "../../../src/config/index.js";
import { resolvePlannerRoute, resolveTaskRoute } from "../../../src/roles/router.js";

// R7.4: the request's models sit above every other route source, through the one
// resolution path in router.ts (resolveTaskRoute for tasks, resolvePlannerRoute for the planner).

type Settings = Contracts.Settings;

function settingsWith(extra: Partial<Settings>): Settings {
  return {
    ...(DEFAULT_SETTINGS as Settings),
    ...extra,
    profiles: {
      claude: {
        plan: { model: "claude-opus-5-5", effort: "high" },
        work: { model: "claude-opus-5-5", effort: "high" },
      },
    },
    defaults: { planner_provider: "claude", worker_provider: "claude" },
  } as Settings;
}

describe("R7.4 resolveTaskRoute: the named worker", () => {
  it("beats routing.<class>, the profile slot and roles.worker for every class in plan mode", () => {
    const settings = settingsWith({
      routing: { feature: { backend: "claude", model: "claude-opus-5-5" }, tests: { backend: "claude", model: "claude-opus-5-5" } },
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        worker: { backend: "claude", model: "claude-opus-5-5" },
        requested: { worker: { backend: "claude", model: "haiku" } },
      },
    } as Partial<Settings>);
    expect(resolveTaskRoute("feature", 1, settings).model).toBe("haiku");
    expect(resolveTaskRoute("tests", 1, settings).model).toBe("haiku");
    expect(resolveTaskRoute("search", 1, settings).model).toBe("haiku");
  });

  it("keeps the class effort when the request sets none, and takes the request's effort when it does", () => {
    const base = settingsWith({
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        requested: { worker: { backend: "claude", model: "haiku" } },
      },
    } as Partial<Settings>);
    expect(resolveTaskRoute("feature", 1, base).effort).toBe("high");
    const withEffort = {
      ...base,
      roles: { ...base.roles, requested: { worker: { backend: "claude", model: "haiku", effort: "low" } } },
    } as Settings;
    expect(resolveTaskRoute("feature", 1, withEffort).effort).toBe("low");
  });

  it("does not escalate away from a named model on a later generation", () => {
    const settings = settingsWith({
      routing: { escalation: ["haiku", "sonnet", "opus"] } as unknown as Settings["routing"],
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        requested: { worker: { backend: "claude", model: "claude-sonnet-5-5" } },
      },
    } as Partial<Settings>);
    expect(resolveTaskRoute("feature", 3, settings).model).toBe("claude-sonnet-5-5");
  });

  it("without a request, plan-mode tasks ignore roles.worker as before (explicit settings path unchanged)", () => {
    const settings = settingsWith({
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        worker: { backend: "claude", model: "haiku" },
      },
    } as Partial<Settings>);
    expect(resolveTaskRoute("feature", 1, settings).model).toBe("claude-opus-5-5");
  });

  it("solo mode: the worker role applies when no request is named, and the request wins over it", () => {
    const settings = settingsWith({
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        worker: { backend: "claude", model: "claude-sonnet-5-5" },
      },
    } as Partial<Settings>);
    expect(resolveTaskRoute("feature", 1, settings, { solo: true }).model).toBe("claude-sonnet-5-5");
    const requested = {
      ...settings,
      roles: { ...settings.roles, requested: { worker: { backend: "claude", model: "haiku" } } },
    } as Settings;
    expect(resolveTaskRoute("feature", 1, requested, { solo: true }).model).toBe("haiku");
  });
});

describe("R7.4 resolvePlannerRoute: the named planner", () => {
  it("beats the profile's plan slot", () => {
    const settings = settingsWith({
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        requested: { planner: { backend: "claude", model: "claude-sonnet-5-5" } },
      },
    } as Partial<Settings>);
    expect(resolvePlannerRoute(settings)).toEqual({ backend: "claude", model: "claude-sonnet-5-5", effort: "high" });
  });

  it("a request that names only a model keeps the profile's backend", () => {
    const base = settingsWith({});
    const settings = {
      ...base,
      profiles: { opencode: { plan: { model: "opencode/a" }, work: { model: "opencode/a" } } },
      defaults: { planner_provider: "opencode", worker_provider: "opencode" },
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        requested: { planner: { model: "opencode/b" } },
      },
    } as Settings;
    expect(resolvePlannerRoute(settings)).toEqual({ backend: "opencode", model: "opencode/b" });
  });

  it("without a request the profile still wins over roles.planner", () => {
    const settings = settingsWith({
      roles: { planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" } },
    } as Partial<Settings>);
    expect(resolvePlannerRoute(settings).model).toBe("claude-opus-5-5");
  });
});

describe("R7.4 withRequestedRoles and the file refusal", () => {
  it("marks a role with a model, and nothing when no role names a model", () => {
    const marked = withRequestedRoles({
      roles: { planner: { model: "a", backend: "claude" }, worker: { model: "b" } },
    } as Partial<Settings>) as { roles: Record<string, unknown> };
    expect(marked.roles.requested).toEqual({
      planner: { model: "a", backend: "claude" },
      worker: { model: "b" },
    });
    const effortOnly = { roles: { planner: { effort: "high" } } } as Partial<Settings>;
    expect(withRequestedRoles(effortOnly)).toBe(effortOnly);
  });

  it("refuses roles.requested in a settings file, and allows it in the flags layer", () => {
    const fileLayers = {
      env: {},
      project: { path: "/x/.substrate/settings.json", value: { roles: { requested: { worker: { model: "m" } } } } },
    };
    expect(() => assertNoRequestedRolesInFiles(fileLayers)).toThrow(/roles\.requested/);
    expect(() =>
      assertNoRequestedRolesInFiles({ env: {}, flags: { roles: { requested: { worker: { model: "m" } } } } }),
    ).not.toThrow();
  });
});
