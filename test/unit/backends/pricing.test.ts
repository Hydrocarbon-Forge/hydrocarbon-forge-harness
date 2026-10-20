import { describe, expect, it } from "vitest";

import { DEFAULT_PRICING } from "../../../src/backends/default-pricing.js";
import {
  calculateCostUsd,
  pricingTableFor,
  ratesFor,
} from "../../../src/backends/pricing.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";

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

describe("pricing: calculateCostUsd (cost source for unlisted and listed models)", () => {
  it("returns cost_usd: 0 and cost_source: 'unknown' for unlisted model without throwing", () => {
    const { cost_usd, cost_source } = calculateCostUsd(DEFAULT_PRICING, "custom-unlisted-model", {
      input_tokens: 500,
      output_tokens: 200,
    });

    expect(cost_source).toBe("unknown");
    expect(cost_usd).toBe(0);
  });

  it("computes cost for a listed model", () => {
    const { cost_usd, cost_source } = calculateCostUsd(DEFAULT_PRICING, "claude-haiku-5-5", {
      input_tokens: 1000,
      output_tokens: 1000,
    });

    expect(cost_source).toBe("computed");
    expect(cost_usd).toBeCloseTo(0.0006, 6);
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

describe("pricing: ratesFor (effort-suffixed ids)", () => {
  const rate = (n: number) => ({ input_per_mtok: n, output_per_mtok: n * 5 });
  const models = {
    base: rate(1),
    "x-high": rate(2),
    "exact-low": rate(3),
    "exact": rate(4),
    "exact-medium": rate(5),
  };

  it("uses the exact key when present, even when the base is also priced", () => {
    expect(ratesFor("exact-low", models)).toEqual(rate(3));
    expect(ratesFor("exact", models)).toEqual(rate(4));
  });

  it("maps each effort suffix to the base id's rates", () => {
    expect(ratesFor("base-low", models)).toEqual(rate(1));
    expect(ratesFor("base-medium", models)).toEqual(rate(1));
    expect(ratesFor("base-high", models)).toEqual(rate(1));
  });

  it("returns undefined when the base is not priced", () => {
    expect(ratesFor("nobase-high", models)).toBeUndefined();
    expect(ratesFor("nobase", models)).toBeUndefined();
  });

  it("strips only one effort suffix", () => {
    expect(ratesFor("x-high-low", models)).toEqual(rate(2));
    expect(ratesFor("x-high-low", { x: rate(9) })).toBeUndefined();
    expect(ratesFor("x-high-low", { "x-high": rate(2) })).toEqual(rate(2));
  });

  it("never prices prototype keys", () => {
    expect(ratesFor("constructor", models)).toBeUndefined();
    expect(ratesFor("__proto__", models)).toBeUndefined();
    expect(ratesFor("toString-high", models)).toBeUndefined();
    expect(ratesFor("constructor-low", models)).toBeUndefined();
  });
});

describe("pricing: effort-suffixed ids in calculateCostUsd (built-in table)", () => {
  it("prices gemini-3.8-flash effort variants at the base rates", () => {
    const base = calculateCostUsd(DEFAULT_PRICING, "gemini-3.8-flash", {
      input_tokens: 1000,
      output_tokens: 1000,
    });
    for (const id of ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]) {
      const res = calculateCostUsd(DEFAULT_PRICING, id, { input_tokens: 1000, output_tokens: 1000 });
      expect(res.cost_source).toBe("computed");
      expect(res.cost_usd).toBe(base.cost_usd);
    }
  });

  it("leaves gpt-oss-120b-medium unpriced (base absent)", () => {
    const res = calculateCostUsd(DEFAULT_PRICING, "gpt-oss-120b-medium", {
      input_tokens: 1000,
      output_tokens: 1000,
    });
    expect(res).toEqual({ cost_usd: 0, cost_source: "unknown" });
  });

  it("leaves claude-opus-4-6-thinking and claude-sonnet-4-6 unpriced", () => {
    for (const id of ["claude-opus-4-6-thinking", "claude-sonnet-4-6"]) {
      expect(calculateCostUsd(DEFAULT_PRICING, id, { input_tokens: 1, output_tokens: 1 }).cost_source).toBe("unknown");
    }
  });
});
