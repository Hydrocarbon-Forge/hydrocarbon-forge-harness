import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseJsonc,
  sandboxProblem,
} from "../../../src/config/index.js";
import { deepMerge } from "../../../src/util/merge.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "substrate-cfg-"));
}

function writeSettingsFile(dir: string, rel: string, body: string): string {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
}

const MINIMAL_FILE_SETTINGS = {
  backends: {},
  roles: { planner: { backend: "claude", model: "m" } },
  routing: { feature: { backend: "claude", model: "m" } },
  pricing: { asOf: "2026-10-16", sources: ["https://example.com"], models: {} },
  budgets: {
    l1_replans_per_task: 2,
    l2_per_run: 2,
    planner_format_retries: 2,
  },
  concurrency: { workers: 3 },
  permissions: { allow: [], deny: [] },
  sandbox: { enabled: true },
  git: { on_scope_violation: "revert", auto_merge: false },
  instructions: { workers: "none" },
  execution: { strategy: "direct" },
};

function settingsValidates(value: unknown): boolean {
  const Settings = (
    Contracts as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean } }>
  ).Settings;
  return Settings.safeParse(value).success;
}

describe("config JSONC tolerance", () => {
  it("parses comments and trailing commas", () => {
    const parsed = parseJsonc(
      `{
        // user comment
        "a": 1, /* block comment */
        "b": [1, 2,],
      }`,
      "settings.json",
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ a: 1, b: [1, 2] });
  });

  it("parses strict JSON as-is", () => {
    expect(parseJsonc(`{"a":1}`, "settings.json")).toEqual({ a: 1 });
  });

  it("malformed JSONC errors naming file and position, not a silent default", () => {
    let message = "";
    try {
      parseJsonc(`{"a": }`, "my-settings.json");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("my-settings.json");
    expect(message.length).toBeGreaterThan("my-settings.json".length);
  });
});

describe("config merge: objects merge, scalars and arrays replace", () => {
  it("higher layer wins; objects merge key-wise", () => {
    const merged = deepMerge(
      { concurrency: { workers: 1 }, sandbox: { enabled: false } },
      { concurrency: { workers: 5 } },
    ) as Record<string, Record<string, unknown>>;
    expect(merged["concurrency"]).toEqual({ workers: 5 });
    expect(merged["sandbox"]).toEqual({ enabled: false });
  });

  it("scalars and arrays replace instead of concatenating", () => {
    const merged = deepMerge(
      { permissions: { allow: ["A"], deny: ["B"] } },
      { permissions: { allow: ["C"], deny: ["D"] } },
    ) as Record<string, Record<string, unknown[]>>;
    expect(merged["permissions"]["allow"]).toEqual(["C"]);
    expect(merged["permissions"]["deny"]).toEqual(["D"]);
  });

  it("skips undefined layers", () => {
    expect(deepMerge<unknown>(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("config loading: precedence and defaults", () => {
  it("missing files resolve to defaults that validate against Settings", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    const settings = await loadSettings({ projectDir, userConfigDir: userDir, env: {} });
    expect(settingsValidates(settings)).toBe(true);
  });

  it("empty settings file uses defaults without throwing", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(projectDir, ".substrate/settings.json", `{}`);
    const settings = await loadSettings({ projectDir, userConfigDir: userDir, env: {} });
    expect(settingsValidates(settings)).toBe(true);
  });

  it("malformed settings file errors instead of silently defaulting", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    const file = writeSettingsFile(projectDir, ".substrate/settings.json", `{"a": }`);
    await expect(loadSettings({ projectDir, userConfigDir: userDir, env: {} })).rejects.toThrow();
    try {
      await loadSettings({ projectDir, userConfigDir: userDir, env: {} });
    } catch (err) {
      expect((err as Error).message).toContain(file.split("/").slice(-1)[0]);
    }
  });

  it("unknown settings keys error rather than being ignored", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({ ...MINIMAL_FILE_SETTINGS, typoKey: 1 }),
    );
    await expect(loadSettings({ projectDir, userConfigDir: userDir, env: {} })).rejects.toThrow(/typoKey/);
  });

  it("a roles.governor key is rejected by the strict schema, naming the key (governor deleted)", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({
        ...MINIMAL_FILE_SETTINGS,
        roles: { ...MINIMAL_FILE_SETTINGS.roles, governor: { enabled: false, endpoint: "" } },
      }),
    );
    await expect(loadSettings({ projectDir, userConfigDir: userDir, env: {} })).rejects.toThrow(/governor/);
  });

  it("R6.7: keys nothing read (git.branch_prefix, sandbox.network, hooks) are rejected by the strict schema", async () => {
    const removed: Array<[string, Record<string, unknown>, RegExp]> = [
      ["git.branch_prefix", { git: { on_scope_violation: "revert", branch_prefix: "substrate/", auto_merge: false } }, /branch_prefix/],
      ["sandbox.network", { sandbox: { enabled: false, network: "deny" } }, /network/],
      ["hooks", { hooks: { stop: [{ command: "true" }] } }, /hooks/],
    ];
    for (const [label, patch, pattern] of removed) {
      const projectDir = tmp();
      const userDir = tmp();
      writeSettingsFile(
        projectDir,
        ".substrate/settings.json",
        JSON.stringify({ ...MINIMAL_FILE_SETTINGS, ...patch }),
      );
      await expect(loadSettings({ projectDir, userConfigDir: userDir, env: {} }), label).rejects.toThrow(pattern);
    }
  });

  it("precedence: project < local < --settings < flags, higher wins", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({ ...MINIMAL_FILE_SETTINGS, concurrency: { workers: 1 } }),
    );
    writeSettingsFile(
      projectDir,
      ".substrate/settings.local.json",
      JSON.stringify({ concurrency: { workers: 2 } }),
    );
    const cliFile = writeSettingsFile(tmp(), "cli.json", JSON.stringify({ concurrency: { workers: 4 } }));

    const fromLocal = (await loadSettings({ projectDir, userConfigDir: userDir, env: {} })) as {
      concurrency: { workers: number };
    };
    expect(fromLocal.concurrency.workers).toBe(2);

    const fromCli = (await loadSettings({
      projectDir,
      userConfigDir: userDir,
      settingsFile: cliFile,
      env: {},
    })) as { concurrency: { workers: number } };
    expect(fromCli.concurrency.workers).toBe(4);

    const fromFlags = (await loadSettings({
      projectDir,
      userConfigDir: userDir,
      settingsFile: cliFile,
      flags: { concurrency: { workers: 7 } },
      env: {},
    })) as { concurrency: { workers: number } };
    expect(fromFlags.concurrency.workers).toBe(7);
  });

  it("user layer loses to project layer", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(userDir, "settings.json", JSON.stringify({ concurrency: { workers: 9 } }));
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({ ...MINIMAL_FILE_SETTINGS, concurrency: { workers: 1 } }),
    );
    const settings = (await loadSettings({ projectDir, userConfigDir: userDir, env: {} })) as {
      concurrency: { workers: number };
    };
    expect(settings.concurrency.workers).toBe(1);
    rmSync(userDir, { recursive: true, force: true });
  });

  it("missing explicit settings file rejects naming the path", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    const missing = join(tmp(), "no-such-settings.json");
    await expect(
      loadSettings({ projectDir, userConfigDir: userDir, settingsFile: missing, env: {} }),
    ).rejects.toThrow(/^Settings file not found: /);
  });
});

describe("config overlay: env and flag values validate against Settings", () => {
  it("valid flag overlay replaces file value", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify(MINIMAL_FILE_SETTINGS),
    );
    const settings = (await loadSettings({
      projectDir,
      userConfigDir: userDir,
      flags: { concurrency: { workers: 7 } },
      env: {},
    })) as { concurrency: { workers: number } };
    expect(settings.concurrency.workers).toBe(7);
    expect(settingsValidates(settings)).toBe(true);
  });

  it("invalid overlay is rejected, file value is left otherwise", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(projectDir, ".substrate/settings.json", JSON.stringify(MINIMAL_FILE_SETTINGS));
    await expect(
      loadSettings({
        projectDir,
        userConfigDir: userDir,
        flags: { concurrency: { workers: "many" } } as never,
        env: {},
      }),
    ).rejects.toThrow();
    const kept = (await loadSettings({
      projectDir,
      userConfigDir: userDir,
      flags: { concurrency: { workers: 7 } } as never,
      env: {},
    })) as { concurrency: { workers: number } };
    expect(kept.concurrency.workers).toBe(7);
  });
});

describe("config edge cases from the spec", () => {
  it("routing.escalation survives load/merge without route validation", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({
        ...MINIMAL_FILE_SETTINGS,
        routing: {
          feature: { backend: "claude", model: "m" },
          escalation: ["haiku", "sonnet", "opus"],
        },
      }),
    );
    const settings = (await loadSettings({ projectDir, userConfigDir: userDir, env: {} })) as {
      routing: Record<string, unknown>;
    };
    expect(settings.routing["escalation"]).toEqual(["haiku", "sonnet", "opus"]);
    expect(settingsValidates(settings)).toBe(true);
  });

  it("empty pricing.models is valid; asOf/sources/models stay required", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    writeSettingsFile(
      projectDir,
      ".substrate/settings.json",
      JSON.stringify({
        ...MINIMAL_FILE_SETTINGS,
        pricing: { asOf: "2026-10-16", sources: ["https://example.com"], models: {} },
      }),
    );
    const settings = await loadSettings({ projectDir, userConfigDir: userDir, env: {} });
    expect(settingsValidates(settings)).toBe(true);

    await expect(
      loadSettings({
        projectDir,
        userConfigDir: userDir,
        flags: { pricing: { invalid_extra: 123 } } as never,
        env: {},
      }),
    ).rejects.toThrow();
  });
});

describe("R1.5: settings schema and sandbox", () => {
  it("--model and --worker-model settings validate (no exit 2, C-H18)", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    const settings = (await loadSettings({
      projectDir,
      userConfigDir: userDir,
      env: {},
      flags: {
        roles: {
          planner: { backend: "claude", model: "planner-model" },
          worker: { backend: "claude", model: "worker-model" },
        },
      },
    })) as { roles: { planner: { model: string }; worker?: { model: string } } };
    expect(settings.roles.planner.model).toBe("planner-model");
    expect(settings.roles.worker?.model).toBe("worker-model");
    expect(settingsValidates(settings)).toBe(true);
  });

  it("sandbox.enabled defaults to false", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    const settings = (await loadSettings({ projectDir, userConfigDir: userDir, env: {} })) as {
      sandbox: { enabled: boolean };
    };
    expect(settings.sandbox.enabled).toBe(false);
  });

  it("sandboxProblem returns the bwrap message when enabled and which says false", () => {
    const enabled = { ...DEFAULT_SETTINGS, sandbox: { enabled: true } } as unknown as Contracts.Settings;
    expect(sandboxProblem(enabled, () => false)).toBe(
      "sandbox.enabled is true but bwrap is not installed; install bubblewrap or set sandbox.enabled to false",
    );
    expect(sandboxProblem(enabled, () => true)).toBeNull();
    expect(sandboxProblem(DEFAULT_SETTINGS, () => false)).toBeNull();
    expect(sandboxProblem({} as unknown as Contracts.Settings, () => false)).toBeNull();
  });
});
