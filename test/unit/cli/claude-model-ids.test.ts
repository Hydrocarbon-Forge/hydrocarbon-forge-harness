import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRequest } from "../../../src/cli/request.js";
import { createAdapters } from "../../../src/backends/registry.js";
import { loadSettings } from "../../../src/config/index.js";
import type { HarnessAdapter, Settings } from "../../../src/contracts/index.js";

// The claude harness accepts the Claude 5 family ids (R7.6) with the same status as
// claude-sonnet-5-5. The adapter's real listModels is used; validateEnvironment is stubbed
// so no binary runs.

const CLAUDE_5_IDS = ["claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"];

function stubbedAdapters(settings: Settings): Record<string, HarnessAdapter> {
  const real = createAdapters(settings).claude;
  const claude = {
    name: "claude",
    capabilities: { version_pin: undefined },
    validateEnvironment: async () => ({ ok: true, pin_matches: true, problems: [] }),
    listModels: () => real.listModels!(),
  };
  return { claude } as unknown as Record<string, HarnessAdapter>;
}

async function validateWorker(tmp: string, model: string) {
  const settings = await loadSettings({ projectDir: tmp });
  const reqFile = path.join(tmp, "request.json");
  fs.writeFileSync(
    reqFile,
    JSON.stringify({ goal: "Build feature Z", mode: "solo", worker: { provider: "claude", model } }),
    "utf8",
  );
  return loadRequest(reqFile, undefined, {}, {
    repoRoot: tmp,
    settings,
    adapters: stubbedAdapters(settings),
  });
}

describe("R7.6: Claude 5 model ids in the claude harness catalog", () => {
  it.each(CLAUDE_5_IDS)("accepts %s as a worker model", async (id) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-r76-accept-"));
    try {
      const res = await validateWorker(tmp, id);
      expect(res.ok, JSON.stringify(res)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a bogus claude id and the fix lists every accepted id", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-r76-reject-"));
    try {
      const res = await validateWorker(tmp, "claude-bogus-9-9");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const problem = res.problems.find((p) => p.field === "worker.model");
      expect(problem?.message).toBe("unknown model 'claude-bogus-9-9'");
      const accepted = problem?.fix.replace(/^valid ids: /, "").split(", ") ?? [];
      for (const id of [...CLAUDE_5_IDS, "haiku", "sonnet", "opus", "fable"]) {
        expect(accepted).toContain(id);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("validation writes no model cache and creates no .substrate directory", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-r76-nowrite-"));
    try {
      await validateWorker(tmp, "claude-haiku-5-5");
      expect(fs.existsSync(path.join(tmp, ".substrate"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
