import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SETTINGS, validateProfiles } from "../../src/config/index.js";
import { deepMerge } from "../../src/util/merge.js";
import { Settings } from "../../src/contracts/index.js";
import { pricingTableFor } from "../../src/backends/pricing.js";
import {
  appendRecord,
  captureEvidence,
  cheapestModel,
  createToyRepo,
  emptyListingMessage,
  firstFailureEvent,
  liveLocalSettings,
  liveModelOverride,
  liveSettings,
  LIVE_HARNESSES,
  pickPricedModel,
  recordPath,
  requirePricedOverride,
  RUN_CAP_USD,
  type LiveRecord,
} from "./helpers.js";

const ORIGINAL_ENV = process.env.SUBSTRATE_LIVE_RECORDS;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "live-helpers-test-"));
  process.env.SUBSTRATE_LIVE_RECORDS = join(scratch, "nested", "live-smoke.json");
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SUBSTRATE_LIVE_RECORDS;
  else process.env.SUBSTRATE_LIVE_RECORDS = ORIGINAL_ENV;
  rmSync(scratch, { recursive: true, force: true });
});

function rec(harness: LiveRecord["harness"], status: LiveRecord["status"], run_id = "-"): LiveRecord {
  return {
    harness,
    version: "1.0.0",
    model: "m",
    run_id,
    status,
    exit_code: status === "skipped" ? null : 0,
    cost_usd: 0,
    ts: "2026-10-19T00:00:00.000Z",
  };
}

describe("cheapestModel", () => {
  const prices = {
    cheap: { input_per_mtok: 0.1, output_per_mtok: 0.5 },
    mid: { input_per_mtok: 1, output_per_mtok: 5 },
    dearOut: { input_per_mtok: 0.1, output_per_mtok: 9 },
  };

  it("picks the lowest input plus output price", () => {
    const models = [
      { id: "mid", efforts: [], source: "static" as const },
      { id: "cheap", efforts: [], source: "static" as const },
      { id: "dearOut", efforts: [], source: "static" as const },
    ];
    expect(cheapestModel(models, prices)?.id).toBe("cheap");
  });

  it("sorts unpriced models last", () => {
    const models = [
      { id: "aaa-unpriced", efforts: [], source: "cli" as const },
      { id: "mid", efforts: [], source: "static" as const },
    ];
    expect(cheapestModel(models, prices)?.id).toBe("mid");
  });

  it("breaks ties by id and does not mutate its input", () => {
    const models = [
      { id: "b", efforts: [], source: "static" as const },
      { id: "a", efforts: [], source: "static" as const },
    ];
    const before = JSON.stringify(models);
    const tied = { x: { input_per_mtok: 1, output_per_mtok: 1 }, y: { input_per_mtok: 1, output_per_mtok: 1 } };
    expect(cheapestModel([{ id: "y", efforts: [], source: "static" }, { id: "x", efforts: [], source: "static" }], tied)?.id).toBe("x");
    expect(cheapestModel(models, {})?.id).toBe("a");
    expect(JSON.stringify(models)).toBe(before);
  });

  it("returns undefined for an empty list", () => {
    expect(cheapestModel([], prices)).toBeUndefined();
  });

  it("on a price tie picks the lowest effort tier, with the untiered id last", () => {
    const tied = { base: { input_per_mtok: 1, output_per_mtok: 1 } };
    const pick = (...ids: string[]) =>
      cheapestModel(ids.map((id) => ({ id, efforts: [], source: "static" as const })), tied)?.id;
    expect(pick("base-high", "base-medium", "base-low")).toBe("base-low");
    expect(pick("base-high", "base-medium")).toBe("base-medium");
    expect(pick("base-high", "base")).toBe("base-high");
    expect(pick("base", "base-low", "base-high")).toBe("base-low");
  });

  it("prices an effort variant at its base's rates and keeps unpriced variants last", () => {
    const models = [
      { id: "zzz-unpriced-high", efforts: [], source: "cli" as const },
      { id: "mid-high", efforts: [], source: "static" as const },
    ];
    expect(cheapestModel(models, prices)?.id).toBe("mid-high");
  });
});

describe("appendRecord and recordPath", () => {
  it("honours SUBSTRATE_LIVE_RECORDS and creates the directory", () => {
    expect(recordPath()).toBe(process.env.SUBSTRATE_LIVE_RECORDS);
    appendRecord(rec("claude", "skipped"));
    expect(existsSync(process.env.SUBSTRATE_LIVE_RECORDS!)).toBe(true);
  });

  it("appends in order, reads missing file as empty, and leaves no temp files", () => {
    appendRecord(rec("claude", "skipped"));
    appendRecord(rec("agy", "passed", "r_AAAAAAAAAAAA"));
    const file = recordPath();
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LiveRecord[];
    expect(parsed.map((r) => [r.harness, r.status])).toEqual([
      ["claude", "skipped"],
      ["agy", "passed"],
    ]);
    expect(readdirSync(join(scratch, "nested"))).toEqual(["live-smoke.json"]);
  });

  it("refuses to overwrite a corrupt record file", () => {
    const file = process.env.SUBSTRATE_LIVE_RECORDS!;
    mkdirSync(join(scratch, "nested"), { recursive: true });
    writeFileSync(file, '{"not":"an array"}', "utf8");
    expect(() => appendRecord(rec("opencode", "failed"))).toThrow(/not a JSON array/);
    expect(readFileSync(file, "utf8")).toBe('{"not":"an array"}');
  });
});

describe("liveSettings", () => {
  it.each(LIVE_HARNESSES)("%s: validates against Settings with caps, slots and routes", (harness) => {
    const overlay = liveSettings(harness, "some-model");
    const merged = deepMerge(DEFAULT_SETTINGS, overlay as never);
    expect(() => Settings.parse(merged)).not.toThrow();
    expect(() => validateProfiles(merged)).not.toThrow();
    expect(merged.profiles?.[harness]).toEqual({ plan: { model: "some-model" }, work: { model: "some-model" } });
    expect(merged.defaults).toEqual({ planner_provider: harness, worker_provider: harness });
    expect(merged.roles.planner).toMatchObject({ backend: harness, model: "some-model" });
    expect(merged.roles.worker).toMatchObject({ backend: harness, model: "some-model" });
  });
});

describe("createToyRepo", () => {
  it("is a git repo with package.json and src/math.js", () => {
    const repo = createToyRepo();
    try {
      expect(existsSync(join(repo.dir, "package.json"))).toBe(true);
      expect(existsSync(join(repo.dir, "src", "math.js"))).toBe(true);
      expect(execFileSync("git", ["log", "--format=%s"], { cwd: repo.dir, encoding: "utf8" }).trim()).toBe("seed");
    } finally {
      repo.cleanup();
    }
  });
});

describe("pickPricedModel (unpriced guard and empty listing)", () => {
  const prices = {
    cheap: { input_per_mtok: 0.1, output_per_mtok: 0.5 },
    mid: { input_per_mtok: 1, output_per_mtok: 5 },
  };
  const listed = (...ids: string[]) => ids.map((id) => ({ id, efforts: [], source: "cli" as const }));

  it("returns the cheapest priced model and writes no record", () => {
    const picked = pickPricedModel("claude", listed("mid", "cheap", "zzz-unpriced"), prices, "2.1.304");
    expect(picked.id).toBe("cheap");
    expect(existsSync(process.env.SUBSTRATE_LIVE_RECORDS!)).toBe(false);
  });

  it("with every listed model unpriced: throws, appends one failed record, and names the harness and ids", () => {
    const models = listed("gemini-3.8-flash-high", "claude-opus-4-6-thinking");
    expect(() => pickPricedModel("agy", models, {}, "1.4.2")).toThrow(
      /no listed model for agy has a price, so the \$0\.25 cap cannot be enforced; add a rate for one of these ids under pricing\.models in \.substrate\/settings\.json \(nothing was spent\)\. Offered ids: gemini-3\.8-flash-high, claude-opus-4-6-thinking/,
    );
    const rows = JSON.parse(readFileSync(process.env.SUBSTRATE_LIVE_RECORDS!, "utf8")) as LiveRecord[];
    expect(rows).toEqual([
      {
        harness: "agy",
        version: "1.4.2",
        model: "-",
        run_id: "-",
        status: "failed",
        exit_code: null,
        cost_usd: 0,
        ts: expect.any(String),
      },
    ]);
  });

  it("with an empty listing: throws the opencode message and appends a failed record", () => {
    expect(() => pickPricedModel("opencode", [], prices, "2.0.21")).toThrow(
      "opencode: 'opencode models --standalone' printed no models; configure a provider (for example log in with opencode) and re-run (nothing was spent)",
    );
    const rows = JSON.parse(readFileSync(process.env.SUBSTRATE_LIVE_RECORDS!, "utf8")) as LiveRecord[];
    expect(rows.map((r) => [r.harness, r.status, r.run_id])).toEqual([["opencode", "failed", "-"]]);
  });

  it("uses the harness's own name in the empty-listing message for other harnesses", () => {
    expect(emptyListingMessage("claude")).toContain("claude");
    expect(emptyListingMessage("claude")).toContain("(nothing was spent)");
    expect(emptyListingMessage("opencode")).toContain("opencode models --standalone");
  });

  it("a rate added to the project pricing makes the pick and the run overlay agree", () => {
    const settings = {
      pricing: { asOf: "2026-10-19", sources: ["https://example.com"], models: { "agy-only-x": { input_per_mtok: 0.01, output_per_mtok: 0.02 } } },
    } as never;
    const table = pricingTableFor(settings);
    const picked = pickPricedModel("agy", listed("agy-only-x", "gemini-3.8-flash-high"), table.models, "1.4.2");
    expect(picked.id).toBe("agy-only-x");
    const overlay = liveSettings("agy", picked.id, table);
    expect(overlay.pricing?.models?.["agy-only-x"]).toEqual({ input_per_mtok: 0.01, output_per_mtok: 0.02 });
  });

  it("treats an effort variant of a priced base as priced and writes no record", () => {
    const picked = pickPricedModel("agy", listed("mid-high"), prices, "1.4.2");
    expect(picked.id).toBe("mid-high");
    expect(existsSync(process.env.SUBSTRATE_LIVE_RECORDS!)).toBe(false);
  });
});

describe("captureEvidence and firstFailureEvent", () => {
  it("copies the run directory, usage ledger and CLI output into a new directory under the root", () => {
    const fakeRepo = join(scratch, "toy-repo");
    const runDir = join(fakeRepo, ".substrate", "runs", "r_TESTRUN00001");
    mkdirSync(join(runDir, "raw"), { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), '{"type":"task.failed"}\n', "utf8");
    writeFileSync(join(runDir, "raw", "out.txt"), "raw output", "utf8");
    writeFileSync(join(runDir, "settings.json"), "{}", "utf8");
    mkdirSync(join(fakeRepo, ".substrate", "ledger"), { recursive: true });
    writeFileSync(join(fakeRepo, ".substrate", "ledger", "usage.jsonl"), '{"cost_source":"unknown"}\n', "utf8");

    const root = join(scratch, "evidence");
    const dir = captureEvidence({
      harness: "claude",
      repoDir: fakeRepo,
      runDir,
      stdout: '{"status":"failed"}',
      stderr: "boom",
      root,
      now: new Date("2026-10-19T12:00:00.000Z"),
    });

    expect(dir).toBe(join(root, "claude-2026-10-19T12-00-00-000Z"));
    expect(readFileSync(join(dir, "runs", "r_TESTRUN00001", "events.jsonl"), "utf8")).toContain("task.failed");
    expect(readFileSync(join(dir, "runs", "r_TESTRUN00001", "raw", "out.txt"), "utf8")).toBe("raw output");
    expect(existsSync(join(dir, "runs", "r_TESTRUN00001", "settings.json"))).toBe(false);
    expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).toContain("unknown");
    expect(readFileSync(join(dir, "cli-stdout.json"), "utf8")).toBe('{"status":"failed"}');
    expect(readFileSync(join(dir, "cli-stderr.txt"), "utf8")).toBe("boom");
  });

  it("copies no run directory and no usage ledger when there are none", () => {
    const fakeRepo = join(scratch, "empty-repo");
    mkdirSync(fakeRepo, { recursive: true });
    const dir = captureEvidence({ harness: "opencode", repoDir: fakeRepo, runDir: null, stdout: "", stderr: "", root: join(scratch, "ev") });
    expect(existsSync(join(dir, "runs"))).toBe(false);
    expect(existsSync(join(dir, "usage.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "cli-stdout.json"))).toBe(true);
  });

  it("firstFailureEvent returns the first task.failed or run.failed event, truncated to 2000 characters", () => {
    const events = [
      { v: 1, seq: 1, ts: "t", run_id: "r", type: "run.started", data: {} },
      { v: 1, seq: 2, ts: "t", run_id: "r", type: "task.failed", data: { reason: "x".repeat(3000) } },
    ];
    const out = firstFailureEvent(events);
    expect(out).not.toBeNull();
    expect(out!.startsWith('{"v":1,"seq":2')).toBe(true);
    expect(out!.endsWith("...[truncated]")).toBe(true);
    expect(firstFailureEvent([events[0]])).toBeNull();
  });
});

describe("liveModelOverride", () => {
  it("returns undefined when the variable is unset or blank", () => {
    expect(liveModelOverride("opencode", {})).toBeUndefined();
    expect(liveModelOverride("opencode", { SUBSTRATE_LIVE_MODEL_OPENCODE: "" })).toBeUndefined();
    expect(liveModelOverride("opencode", { SUBSTRATE_LIVE_MODEL_OPENCODE: "   " })).toBeUndefined();
  });

  it("returns the trimmed value", () => {
    expect(
      liveModelOverride("opencode", { SUBSTRATE_LIVE_MODEL_OPENCODE: "  opencode-go/deepseek-v4.1-flash \n" }),
    ).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("upper-cases the harness name to find the variable", () => {
    expect(liveModelOverride("agy", { SUBSTRATE_LIVE_MODEL_AGY: "gemini-x" })).toBe("gemini-x");
    expect(liveModelOverride("claude", { SUBSTRATE_LIVE_MODEL_CLAUDE: "sonnet" })).toBe("sonnet");
  });

  it("ignores another harness's variable", () => {
    expect(liveModelOverride("opencode", { SUBSTRATE_LIVE_MODEL_CLAUDE: "sonnet", SUBSTRATE_LIVE_MODEL_AGY: "x" })).toBeUndefined();
  });

  it("reads process.env by default", () => {
    const saved = process.env.SUBSTRATE_LIVE_MODEL_CLAUDE;
    try {
      process.env.SUBSTRATE_LIVE_MODEL_CLAUDE = " opus ";
      expect(liveModelOverride("claude")).toBe("opus");
    } finally {
      if (saved === undefined) delete process.env.SUBSTRATE_LIVE_MODEL_CLAUDE;
      else process.env.SUBSTRATE_LIVE_MODEL_CLAUDE = saved;
    }
  });
});

describe("requirePricedOverride", () => {
  const prices = {
    "opencode-go/deepseek-v4.1-flash": { input_per_mtok: 0.3, output_per_mtok: 1.2 },
    mid: { input_per_mtok: 1, output_per_mtok: 5 },
  };

  it("returns a priced id and writes no record", () => {
    expect(requirePricedOverride("opencode", "opencode-go/deepseek-v4.1-flash", prices, "2.0.21")).toBe(
      "opencode-go/deepseek-v4.1-flash",
    );
    expect(existsSync(process.env.SUBSTRATE_LIVE_RECORDS!)).toBe(false);
  });

  it("treats an effort-suffixed id whose base is priced as priced", () => {
    expect(requirePricedOverride("agy", "mid-high", prices, "1.4.2")).toBe("mid-high");
    expect(existsSync(process.env.SUBSTRATE_LIVE_RECORDS!)).toBe(false);
  });

  it("an unpriced id throws the exact message and appends exactly one failed record", () => {
    expect(() => requirePricedOverride("opencode", "opencode-go/unknown-model", prices, "2.0.21")).toThrow(
      new Error(
        "SUBSTRATE_LIVE_MODEL_OPENCODE=opencode-go/unknown-model has no price, so the $0.25 cap cannot be enforced; " +
          "add a rate for it under pricing.models in .substrate/settings.json (nothing was spent)",
      ),
    );
    const rows = JSON.parse(readFileSync(process.env.SUBSTRATE_LIVE_RECORDS!, "utf8")) as LiveRecord[];
    expect(rows).toEqual([
      {
        harness: "opencode",
        version: "2.0.21",
        model: "-",
        run_id: "-",
        status: "failed",
        exit_code: null,
        cost_usd: 0,
        ts: expect.any(String),
      },
    ]);
  });
});

describe("liveLocalSettings", () => {
  const URL_ENV = { SUBSTRATE_LIVE_OPENCODE_BASE_URL: " http://127.0.0.1:9/v1 " };

  it("puts the trimmed base URL and a models entry for a llama id into the opencode provider", () => {
    const s = liveLocalSettings("opencode", "llama.cpp/qwen3.8-flash-next-iq2_xs", "2.0.21", URL_ENV);
    expect(s).toEqual({
      backends: {
        opencode: {
          provider: {
            id: "llama.cpp",
            npm: "@ai-sdk/openai-compatible",
            base_url: "http://127.0.0.1:9/v1",
            models: { "qwen3.8-flash-next-iq2_xs": {} },
          },
        },
      },
    });
    expect(existsSync(process.env.SUBSTRATE_LIVE_RECORDS!)).toBe(false);
  });

  it("uses provider id local for a model id with no slash", () => {
    const s = liveLocalSettings("opencode", "llama-3.2", "2.0.21", URL_ENV);
    expect(s?.backends?.opencode?.provider).toMatchObject({ id: "local", models: { "llama-3.2": {} } });
  });

  it("throws the clear error and appends one failed record when the URL variable is missing", () => {
    expect(() => liveLocalSettings("opencode", "llama.cpp/qwen3.8-flash-next-iq2_xs", "2.0.21", {})).toThrow(
      new Error(
        "SUBSTRATE_LIVE_OPENCODE_BASE_URL is required when the opencode live model is a local route " +
          "(llama.cpp/qwen3.8-flash-next-iq2_xs); set it to the llama.cpp endpoint, for example " +
          "http://<host>:<port>/v1 (nothing was spent)",
      ),
    );
    const rows = JSON.parse(readFileSync(process.env.SUBSTRATE_LIVE_RECORDS!, "utf8")) as LiveRecord[];
    expect(rows).toEqual([
      {
        harness: "opencode",
        version: "2.0.21",
        model: "-",
        run_id: "-",
        status: "failed",
        exit_code: null,
        cost_usd: 0,
        ts: expect.any(String),
      },
    ]);
  });

  it("leaves a non-local model unchanged (no overlay, no record), even when the URL is set", () => {
    expect(liveLocalSettings("opencode", "opencode/deepseek-v4.1-flash-free", "2.0.21", URL_ENV)).toBeUndefined();
    expect(liveLocalSettings("claude", "sonnet", "1.0.0", URL_ENV)).toBeUndefined();
    expect(liveLocalSettings("opencode", "opencode/deepseek-v4.1-flash-free", "2.0.21", {})).toBeUndefined();
    expect(existsSync(process.env.SUBSTRATE_LIVE_RECORDS!)).toBe(false);
  });
});
