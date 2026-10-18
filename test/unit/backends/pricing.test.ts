import { describe, expect, it } from "vitest";

import { DEFAULT_PRICING } from "../../../src/backends/default-pricing.js";
import {
  calculateCostUsd,
  computeUsageRecord,
  pricingTableFor,
} from "../../../src/backends/pricing.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { nowIsoTimestamp } from "../../../src/util/index.js";

describe("pricing: calculateCostUsd", () => {
  it("calculates computed cost for a priced model (haiku, 1000 in, 1000 out)", () => {
    // claude-haiku-5-5: input 0.1/mtok, output 0.5/mtok
    // (1000 * 0.1 + 1000 * 0.5) / 1_000_000 = 0.0006
    const res = calculateCostUsd(DEFAULT_PRICING, "claude-haiku-5-5", {
      input_tokens: 1000,
      output_tokens: 1000,
    });

    expect(res.cost_source).toBe("computed");
    expect(res.cost_usd).toBeCloseTo(0.0006, 6);
  });

  it("returns {cost_usd: 0, cost_source: 'unknown'} for an unpriced model and does not throw", () => {
    const res = calculateCostUsd(DEFAULT_PRICING, "unlisted-model-foo", {
      input_tokens: 1000,
      output_tokens: 1000,
    });

    expect(res.cost_source).toBe("unknown");
    expect(res.cost_usd).toBe(0);
  });

  it("ignores cache write tokens when model has no cache_write rate (gemini-3.8-flash)", () => {
    // gemini-3.8-flash: input 0.75/mtok, output 3.75/mtok, cache_read 0.075/mtok, no cache_write
    const withoutWrite = calculateCostUsd(DEFAULT_PRICING, "gemini-3.8-flash", {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_tokens: 2000,
    });

    const withWrite = calculateCostUsd(DEFAULT_PRICING, "gemini-3.8-flash", {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_tokens: 2000,
      cache_write_tokens: 50_000,
    });

    // (1000 * 0.75 + 1000 * 3.75 + 2000 * 0.075) / 1M = (750 + 3750 + 150) / 1M = 4650 / 1M = 0.00465
    expect(withoutWrite.cost_source).toBe("computed");
    expect(withoutWrite.cost_usd).toBeCloseTo(0.00465, 6);
    expect(withWrite.cost_usd).toBe(withoutWrite.cost_usd);
  });

  it("returns {cost_usd: 0, cost_source: 'computed'} for zero tokens on a listed model", () => {
    const res = calculateCostUsd(DEFAULT_PRICING, "claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
    });

    expect(res.cost_source).toBe("computed");
    expect(res.cost_usd).toBe(0);
  });

  it("throws on invalid token counts (negative, NaN, infinite)", () => {
    expect(() =>
      calculateCostUsd(DEFAULT_PRICING, "claude-haiku-5-5", {
        input_tokens: -1,
        output_tokens: 10,
      }),
    ).toThrow(/Invalid input_tokens/);

    expect(() =>
      calculateCostUsd(DEFAULT_PRICING, "claude-haiku-5-5", {
        input_tokens: 10,
        output_tokens: NaN,
      }),
    ).toThrow(/Invalid output_tokens/);

    expect(() =>
      calculateCostUsd(DEFAULT_PRICING, "claude-haiku-5-5", {
        input_tokens: 10,
        output_tokens: 10,
        cache_read_tokens: Infinity,
      }),
    ).toThrow(/Invalid cache_read_tokens/);

    expect(() =>
      calculateCostUsd(DEFAULT_PRICING, "claude-haiku-5-5", {
        input_tokens: 10,
        output_tokens: 10,
        cache_write_tokens: -10,
      }),
    ).toThrow(/Invalid cache_write_tokens/);
  });
});

describe("pricing: computeUsageRecord", () => {
  it("keeps record with cost_usd: 0 and cost_source: 'unknown' for unlisted model without throwing", () => {
    const raw = {
      backend: "opencode" as const,
      model: "custom-unlisted-model",
      input_tokens: 500,
      output_tokens: 200,
      at: nowIsoTimestamp(),
    };

    const record = computeUsageRecord(DEFAULT_PRICING, raw);

    expect(record.cost_source).toBe("unknown");
    expect(record.cost_usd).toBe(0);
    expect(record.model).toBe("custom-unlisted-model");
  });

  it("computes cost for a listed model", () => {
    const raw = {
      backend: "claude" as const,
      model: "claude-haiku-5-5",
      input_tokens: 1000,
      output_tokens: 1000,
      at: nowIsoTimestamp(),
    };

    const record = computeUsageRecord(DEFAULT_PRICING, raw);

    expect(record.cost_source).toBe("computed");
    expect(record.cost_usd).toBeCloseTo(0.0006, 6);
  });
});

describe("pricing: pricingTableFor", () => {
  it("returns DEFAULT_PRICING when settings has no model overrides", () => {
    const table = pricingTableFor(DEFAULT_SETTINGS);

    expect(table.asOf).toBe("2026-10-16");
    expect(table.sources).toEqual(DEFAULT_PRICING.sources);
    expect(Object.keys(table.models)).toEqual(Object.keys(DEFAULT_PRICING.models));
  });

  it("overlays settings.pricing.models by model id while keeping other built-in models and metadata", () => {
    const customSettings = {
      ...DEFAULT_SETTINGS,
      pricing: {
        models: {
          "claude-haiku-5-5": {
            input_per_mtok: 0.2,
            output_per_mtok: 1.0,
          },
          "new-model-xyz": {
            input_per_mtok: 5.0,
            output_per_mtok: 15.0,
          },
        },
      },
    };

    const table = pricingTableFor(customSettings);

    expect(table.asOf).toBe("2026-10-16");
    expect(table.sources).toEqual(DEFAULT_PRICING.sources);
    expect(table.models["claude-haiku-5-5"].input_per_mtok).toBe(0.2);
    expect(table.models["claude-haiku-5-5"].output_per_mtok).toBe(1.0);
    // Other built-in models stay
    expect(table.models["claude-opus-5-5"]).toBeDefined();
    expect(table.models["gemini-3.8-flash"]).toBeDefined();
    // New model added
    expect(table.models["new-model-xyz"]).toBeDefined();
  });
});
