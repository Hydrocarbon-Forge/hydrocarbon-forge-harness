import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type {
  HarnessAdapter,
  ModelInfo,
  PricingTable,
  Settings,
} from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { createAdapters } from "../../../src/backends/registry.js";
import { ClaudeAdapter } from "../../../src/backends/adapters/claude.js";
import { OpenCodeAdapter, parseOpenCodeModels } from "../../../src/backends/adapters/opencode.js";
import { AgyAdapter, parseAgyModels } from "../../../src/backends/adapters/agy.js";

// listModels is optional on HarnessAdapter (the protected integration fixtures
// build adapters that do not implement it), so tests resolve it through this.
function listedModels(adapter: HarnessAdapter): Promise<ModelInfo[]> {
  if (!adapter.listModels) {
    throw new Error(`adapter ${adapter.capabilities.name} has no listModels`);
  }
  return adapter.listModels();
}

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../../fixtures/backends");
const fakeHarnessDir = resolve(here, "../../fixtures/fake-harness");

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const ANTHROPIC_EFFORTS = ["high", "max"];
const GOOGLE_EFFORTS = ["low", "high"];

const noPricing: PricingTable = { asOf: "2026-10-18", sources: [], models: {} };

// Captured with `agy models` on 2026-10-18 (S3): the header line, then one
// tab-separated `id<TAB>display` row per model.
const agyFixture = readFileSync(join(fixturesDir, "agy", "models.txt"), "utf8");
// S2 observed one id; the file is marked UNVERIFIED because no providers were
// configured when it was written.
const opencodeFixture = readFileSync(join(fixturesDir, "opencode", "models.txt"), "utf8");

function fixtureLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

function agyRows(text: string): string[] {
  return fixtureLines(text).filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]*\t/.test(line));
}

function opencodeIds(text: string): string[] {
  return fixtureLines(text).filter((line) => !line.startsWith("#")).map((line) => line.split(/\s+/)[0]);
}

function tierOf(id: string): string | null {
  const match = id.match(/-(low|medium|high)$/);
  return match ? match[1] : null;
}

function expectedAgy(text: string): ModelInfo[] {
  return agyRows(text).map((line) => {
    const [id, display] = line.split("\t");
    const tier = tierOf(id);
    return {
      id,
      ...(display === "" ? {} : { display }),
      efforts: tier ? [tier] : [],
      source: "cli",
    };
  });
}

function expectedOpenCode(text: string): ModelInfo[] {
  return opencodeIds(text).map((id) => ({
    id,
    efforts: [],
    source: "cli",
  }));
}

describe("agy models parser (test/fixtures/backends/agy/models.txt)", () => {
  it("yields every captured row with its display and its tier effort", () => {
    const models = parseAgyModels(agyFixture);
    expect(models).toEqual(expectedAgy(agyFixture));
    expect(models).toHaveLength(agyRows(agyFixture).length);
  });

  it("keeps the header line in the fixture and skips it when parsing", () => {
    expect(fixtureLines(agyFixture)[0]).toBe("Fetching available models...");
    const parsed = parseAgyModels(agyFixture);
    expect(parsed.map((model) => model.id)).toEqual(agyRows(agyFixture).map((line) => line.split("\t")[0]));
    expect(parsed.some((model) => model.id.startsWith("Fetching"))).toBe(false);
  });

  it("skips any line that does not start with a model slug followed by a tab", () => {
    const noise = "Fetching available models...\nnot-a-slug-no-tab\nGemini 3.8 Flash\tspaced slug\n";
    const models = parseAgyModels(`${noise}${agyFixture}`);
    expect(models).toEqual(expectedAgy(agyFixture));
  });

  it("gives the tier as the only effort for a slug ending in -low, -medium or -high", () => {
    const models = parseAgyModels(agyFixture);
    expect(models.filter((model) => model.id === "gemini-3.8-flash-high")[0].efforts).toEqual(["high"]);
    expect(models.filter((model) => model.id === "gemini-3.8-flash-medium")[0].efforts).toEqual(["medium"]);
    expect(models.filter((model) => model.id === "gemini-3.8-flash-low")[0].efforts).toEqual(["low"]);
    expect(models.filter((model) => model.id === "claude-sonnet-4-6")[0].efforts).toEqual([]);
    for (const model of models) {
      expect(model.efforts.length).toBeLessThanOrEqual(1);
      if (model.efforts.length === 1) {
        expect(model.id.endsWith(`-${model.efforts[0]}`)).toBe(true);
      }
    }
  });

  it("omits display when the display column is empty", () => {
    const model = parseAgyModels("claude-sonnet-4-6\t")[0];
    expect(model).toEqual({ id: "claude-sonnet-4-6", efforts: [], source: "cli" });
    expect("display" in model).toBe(false);
  });

  it("strips a Windows line ending before parsing", () => {
    const crlf = agyRows(agyFixture).map((line) => `${line}\r`).join("\n");
    expect(parseAgyModels(crlf)).toEqual(expectedAgy(agyFixture));
  });

  it("reports source cli for every model it reads", () => {
    expect(parseAgyModels(agyFixture).every((model) => model.source === "cli")).toBe(true);
  });

  it("returns [] for empty input", () => {
    expect(parseAgyModels("")).toEqual([]);
    expect(parseAgyModels("\n\n")).toEqual([]);
  });
});

describe("opencode models parser (test/fixtures/backends/opencode/models.txt)", () => {
  it("yields the captured id with no family efforts", () => {
    expect(parseOpenCodeModels(opencodeFixture)).toEqual(expectedOpenCode(opencodeFixture));
    expect(opencodeIds(opencodeFixture)).toEqual(["opencode/deepseek-v4.1-flash-free"]);
    expect(parseOpenCodeModels(opencodeFixture)[0].efforts).toEqual([]);
  });

  it("skips the UNVERIFIED header line and blank lines", () => {
    expect(fixtureLines(opencodeFixture)[0]).toContain("UNVERIFIED");
    const models = parseOpenCodeModels(`${fixtureLines(opencodeFixture)[0]}\n\n${opencodeIds(opencodeFixture)[0]}`);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({ id: "opencode/deepseek-v4.1-flash-free", efforts: [], source: "cli" });
  });

  it("uses the first whitespace token as the id and the rest as display", () => {
    expect(parseOpenCodeModels("openai/gpt-4o\t OpenAI GPT-4o ")).toEqual([{
      id: "openai/gpt-4o",
      display: "OpenAI GPT-4o",
      efforts: OPENAI_EFFORTS,
      source: "cli",
    }]);
    expect(parseOpenCodeModels("openai/gpt-4o ")[0].display).toBeUndefined();
  });

  it("gives ids of each family that family's efforts", () => {
    const idsFromCapture = opencodeIds(agyFixture);
    for (const id of idsFromCapture) {
      expect(parseOpenCodeModels(`openai/${id}`)[0].efforts).toEqual(OPENAI_EFFORTS);
      expect(parseOpenCodeModels(`anthropic/${id}`)[0].efforts).toEqual(ANTHROPIC_EFFORTS);
      expect(parseOpenCodeModels(`google/${id}`)[0].efforts).toEqual(GOOGLE_EFFORTS);
    }
    const noFamily = opencodeIds(opencodeFixture)[0].split("/")[0];
    expect(["openai", "anthropic", "google"]).not.toContain(noFamily);
    for (const model of parseOpenCodeModels(opencodeFixture)) {
      expect(model.efforts).toEqual([]);
    }
    expect(parseOpenCodeModels("anything containing gpt-5.4")[0].efforts).toEqual(OPENAI_EFFORTS);
    expect(parseOpenCodeModels("anything containing Claude")[0].efforts).toEqual(ANTHROPIC_EFFORTS);
    expect(parseOpenCodeModels("anything containing GEMINI")[0].efforts).toEqual(GOOGLE_EFFORTS);
  });

  it("reports source cli for every model it reads", () => {
    expect(parseOpenCodeModels(opencodeFixture).every((model) => model.source === "cli")).toBe(true);
  });

  it("returns [] for empty input", () => {
    expect(parseOpenCodeModels("")).toEqual([]);
  });

  it("strips a carriage return before the display text", () => {
    const crlf = opencodeIds(opencodeFixture).map((id) => `${id}\r`).join("\n");
    expect(parseOpenCodeModels(crlf)).toEqual(expectedOpenCode(opencodeFixture));
  });
});

describe("ClaudeAdapter.listModels", () => {
  function adapter(knownModels: string[]): ClaudeAdapter {
    // A binary that cannot be executed: the invariant is that Claude's listModels
    // runs no process at all, so this must still resolve.
    return new ClaudeAdapter({ bin: "claude-binary-must-not-be-run", knownModels });
  }

  it("lists the static aliases first, then the known model ids", async () => {
    const models = await adapter(["openai/gpt-5.4", "anthropic/claude-opus-4-6-thinking", "fable-5"]).listModels();
    expect(models).toEqual([
      { id: "haiku", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "sonnet", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "opus", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "fable", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "openai/gpt-5.4", efforts: CLAUDE_EFFORTS, source: "settings" },
      { id: "anthropic/claude-opus-4-6-thinking", efforts: CLAUDE_EFFORTS, source: "settings" },
      { id: "fable-5", efforts: CLAUDE_EFFORTS, source: "settings" },
    ]);
  });

  it("lists only the aliases when no model ids are known", async () => {
    const models = await adapter([]).listModels();
    expect(models.map((model) => model.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(models.every((model) => model.source === "static")).toBe(true);
  });

  it("returns one entry per duplicate id, keeping the first occurrence", async () => {
    const models = await adapter(["fable", "opus", "openai/gpt-5.4", "openai/gpt-5.4"]).listModels();
    expect(models).toEqual([
      { id: "haiku", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "sonnet", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "opus", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "fable", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "openai/gpt-5.4", efforts: CLAUDE_EFFORTS, source: "settings" },
    ]);
  });

  it("keeps a model id with #variant as written", async () => {
    const models = await adapter(["openai/gpt-5.4#fast"]).listModels();
    expect(models.filter((model) => model.source === "settings")).toEqual([
      { id: "openai/gpt-5.4#fast", efforts: CLAUDE_EFFORTS, source: "settings" },
    ]);
  });

  it("does not run a harness process", async () => {
    await expect(adapter(["openai/gpt-5.4"]).listModels()).resolves.toHaveLength(5);
  });
});

describe("registry passes the settings model ids to Claude", () => {
  it("collects the ids from roles, routing and the price table", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      roles: {
        planner: { backend: "claude", model: "openai/gpt-5.4" },
      },
      routing: {
        review: { backend: "claude", model: "fable-5" },
        escalation: ["haiku", "sonnet"],
      },
      pricing: {
        models: {
          "anthropic/claude-opus-4-6-thinking": { input_per_mtok: 5, output_per_mtok: 25 },
        },
      },
    };

    const models = await listedModels(createAdapters(settings).claude);
    expect(models).toEqual([
      { id: "haiku", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "sonnet", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "opus", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "fable", efforts: CLAUDE_EFFORTS, source: "static" },
      { id: "openai/gpt-5.4", efforts: CLAUDE_EFFORTS, source: "settings" },
      { id: "fable-5", efforts: CLAUDE_EFFORTS, source: "settings" },
      { id: "anthropic/claude-opus-4-6-thinking", efforts: CLAUDE_EFFORTS, source: "settings" },
    ]);
  });

  it("passes ids with no price table entry as settings sources", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      roles: { planner: { backend: "claude", model: "fable-5" } },
      pricing: { models: {} },
    };
    const models = await listedModels(createAdapters(settings).claude);
    // DEFAULT_SETTINGS.routing.feature is a claude route, so its model is a
    // settings id too; its escalation ids deduplicate against the static aliases.
    expect(models.filter((model) => model.source === "settings")).toEqual([
      { id: "fable-5", efforts: CLAUDE_EFFORTS, source: "settings" },
      { id: "claude-sonnet-5-5", efforts: CLAUDE_EFFORTS, source: "settings" },
    ]);
  });
});

describe("listModels through the fake harness dialects", () => {
  it("agy listModels reports the models from its fixture", async () => {
    const adapter = new AgyAdapter({
      bin: join(fakeHarnessDir, "bin", "agy"),
      pricing: noPricing,
    });
    const models = await adapter.listModels();
    expect(models).toEqual(expectedAgy(agyFixture));

    const stdout = await readFixtureThroughBin(join(fakeHarnessDir, "bin", "agy"));
    expect(stdout).toBe(agyFixture);
  });

  it("opencode listModels reports the models from its fixture", async () => {
    const adapter = new OpenCodeAdapter({
      binPath: join(fakeHarnessDir, "bin", "opencode"),
      pricing: noPricing,
    });
    const models = await adapter.listModels();
    expect(models).toEqual(expectedOpenCode(opencodeFixture));

    const stdout = await readFixtureThroughBin(join(fakeHarnessDir, "bin", "opencode"));
    expect(stdout).toBe(opencodeFixture);
  });
});

async function readFixtureThroughBin(binPath: string): Promise<string> {
  const { stdout } = await execFileAsync(binPath, ["models"], { encoding: "utf8", timeout: 30000 });
  return stdout;
}

describe("listModels error wrapping", () => {
  it("agy wraps the failure as `agy models failed: <message>`", async () => {
    const adapter = new AgyAdapter({
      bin: "agy-binary-does-not-exist",
      pricing: noPricing,
    });
    await expect(adapter.listModels()).rejects.toThrow(/^agy models failed: /);
  });

  it("opencode wraps the failure as `opencode models failed: <message>`", async () => {
    const adapter = new OpenCodeAdapter({
      binPath: "opencode-binary-does-not-exist",
      pricing: noPricing,
    });
    await expect(adapter.listModels()).rejects.toThrow(/^opencode models failed: /);
  });
});
