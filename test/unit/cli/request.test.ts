import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadRequest, type ModelCatalog } from "../../../src/cli/request.js";
import type { Settings } from "../../../src/contracts/index.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "substrate-request-test-"));
}

const stubCatalog: ModelCatalog = {
  v: 1,
  generated_at: new Date().toISOString(),
  cache: "fresh",
  providers: [
    {
      provider: "claude",
      installed: true,
      models: [
        {
          id: "claude-haiku-5-5",
          provider: "claude",
          display: "Haiku",
          efforts: ["low", "medium"],
          slots: [],
        },
        {
          id: "claude-sonnet-5-5",
          provider: "claude",
          display: "Sonnet",
          efforts: ["medium", "high"],
          slots: [],
        },
      ],
    },
    {
      provider: "agy",
      installed: false,
      models: [],
    },
  ],
  all_models: [],
};

const defaultSettings = {
  backends: {},
  roles: {
    planner: { backend: "claude", model: "claude-sonnet-5-5" },
    worker: { backend: "claude", model: "claude-haiku-5-5" },
  },
  routing: {
    feature: { backend: "claude", model: "claude-sonnet-5-5" },
    escalation: [],
  },
  defaults: {
    planner_provider: "claude",
    worker_provider: "claude",
  },
  profiles: {
    claude: {
      plan: { model: "claude-sonnet-5-5", effort: "medium" },
      work: { model: "claude-haiku-5-5", effort: "low" },
    },
  },
} as any as Settings;

describe("Unit: Run request schema and validation (R4.1)", () => {
  it("valid file: parses valid request JSON with all fields and maps to overrides", async () => {
    const tmp = createTmpDir();
    const contextFile = path.join(tmp, "context.txt");
    fs.writeFileSync(contextFile, "context contents", "utf8");

    const reqFile = path.join(tmp, "request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        goal: "Build feature X",
        mode: "solo",
        permission_mode: "acceptEdits",
        worker: { provider: "claude", model: "claude-haiku-5-5", effort: "low" },
        verify: ["npm test"],
        budget: { max_usd: 2.5, max_tokens: 50000, max_wall_min: 15 },
        context: ["context.txt"],
      }),
      "utf8"
    );

    const res = await loadRequest(reqFile, undefined, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.request.goal).toBe("Build feature X");
    expect(res.request.mode).toBe("solo");
    expect(res.request.permission_mode).toBe("acceptEdits");
    expect(res.overrides.roles?.worker?.model).toBe("claude-haiku-5-5");
    expect(res.overrides.budgets?.run?.max_usd).toBe(2.5);
    expect(res.overrides.budgets?.run?.max_tokens).toBe(50000);
    expect(res.overrides.budgets?.run?.max_wall_min).toBe(15);
    expect(res.overrides.verify).toEqual(["npm test"]);
    expect(res.overrides.context).toEqual(["context.txt"]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("missing provider: reports problem when provider cannot be resolved for roles", async () => {
    const tmp = createTmpDir();
    const reqFile = path.join(tmp, "request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        goal: "Plan feature Y",
        mode: "plan",
      }),
      "utf8"
    );

    const emptySettings = {
      backends: {},
      roles: {},
      routing: { feature: { backend: "claude", model: "claude-sonnet-5-5" }, escalation: [] },
    } as any as Settings;

    const res = await loadRequest(reqFile, undefined, {}, {
      repoRoot: tmp,
      settings: emptySettings,
      catalog: stubCatalog,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "planner.provider",
          fix: "pass --plan <provider> or set defaults.planner_provider",
        }),
        expect.objectContaining({
          field: "worker.provider",
          fix: "pass --work <provider> or set defaults.worker_provider",
        }),
      ])
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("unknown model: reports problem for installed provider with valid ids fix", async () => {
    const tmp = createTmpDir();
    const reqFile = path.join(tmp, "request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        goal: "Build feature Z",
        mode: "solo",
        worker: { provider: "claude", model: "unknown-gpt-4o" },
      }),
      "utf8"
    );

    const res = await loadRequest(reqFile, undefined, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;

    const problem = res.problems.find((p) => p.field === "worker.model");
    expect(problem).toBeDefined();
    expect(problem?.message).toBe("unknown model 'unknown-gpt-4o'");
    expect(problem?.fix).toContain("valid ids: claude-haiku-5-5, claude-sonnet-5-5");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("unknown model with uninstalled provider: model check is skipped", async () => {
    const tmp = createTmpDir();
    const reqFile = path.join(tmp, "request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        goal: "Build feature on agy",
        mode: "solo",
        worker: { provider: "agy", model: "any-model-id" },
      }),
      "utf8"
    );

    const res = await loadRequest(reqFile, undefined, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });

    // Provider is not installed, so model check is skipped
    expect(res.ok).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("conflicting flags: positional prompt with --request and solo mode with --plan", async () => {
    const tmp = createTmpDir();
    const reqFile = path.join(tmp, "request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        goal: "Build feature A",
        mode: "solo",
      }),
      "utf8"
    );

    // Conflict 1: positional prompt + request file
    const res1 = await loadRequest(reqFile, undefined, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
      rawPrompt: "Conflict prompt",
    });

    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.problems.some((p) => p.field === "goal")).toBe(true);
    }

    // Conflict 2: solo mode with --plan
    const res2 = await loadRequest(reqFile, undefined, { plan: "claude:claude-sonnet-5-5" }, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });

    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      const plannerProblem = res2.problems.find((p) => p.field === "planner");
      expect(plannerProblem).toBeDefined();
      expect(plannerProblem?.message).toBe("solo mode runs no planner");
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("file and stdin inputs: parses stdin, detects empty stdin and file not found", async () => {
    const tmp = createTmpDir();

    // Stdin valid
    const stdinContent = JSON.stringify({
      goal: "From stdin",
      mode: "solo",
      worker: { provider: "claude", model: "claude-haiku-5-5" },
    });
    const resStdin = await loadRequest("-", stdinContent, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });
    expect(resStdin.ok).toBe(true);

    // Stdin empty
    const resEmptyStdin = await loadRequest("-", "   ", {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });
    expect(resEmptyStdin.ok).toBe(false);
    if (!resEmptyStdin.ok) {
      expect(resEmptyStdin.problems[0].field).toBe("request");
      expect(resEmptyStdin.problems[0].message).toBe("stdin is empty");
    }

    // File not found
    const resNotFound = await loadRequest("nonexistent.json", undefined, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });
    expect(resNotFound.ok).toBe(false);
    if (!resNotFound.ok) {
      expect(resNotFound.problems[0].field).toBe("request");
      expect(resNotFound.problems[0].message).toContain("file not found");
    }

    // Unparseable JSON
    const resBadJson = await loadRequest("-", "{ not valid json", {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });
    expect(resBadJson.ok).toBe(false);
    if (!resBadJson.ok) {
      expect(resBadJson.problems[0].field).toBe("request");
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("scope rejection: explicitly rejects unknown key 'scope' with dedicated message", async () => {
    const tmp = createTmpDir();
    const reqFile = path.join(tmp, "request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        goal: "Do work",
        mode: "solo",
        worker: { provider: "claude", model: "claude-haiku-5-5" },
        scope: ["src/**"],
      }),
      "utf8"
    );

    const res = await loadRequest(reqFile, undefined, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.problems).toContainEqual({
      field: "scope",
      message: "scope is not enforced in this version",
      fix: "remove scope",
    });

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("problems list ordering: sorts problems alphabetically by field name", async () => {
    const tmp = createTmpDir();
    const reqFile = path.join(tmp, "request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        goal: "   ",
        mode: "solo",
        worker: { provider: "claude", model: "bad-model", effort: "invalid-effort" },
        context: ["missing-file-1.txt", "missing-file-2.txt"],
        scope: ["src/**"],
      }),
      "utf8"
    );

    const res = await loadRequest(reqFile, undefined, {}, {
      repoRoot: tmp,
      settings: defaultSettings,
      catalog: stubCatalog,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;

    const fields = res.problems.map((p) => p.field);
    const sortedFields = [...fields].sort((a, b) => a.localeCompare(b));
    expect(fields).toEqual(sortedFields);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
