import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import { nowIsoTimestamp } from "../../../src/util/index.js";
import { calculateCostUsd } from "../../../src/backends/pricing.js";

const S4_PRICING: Contracts.PricingTable = Contracts.PricingTable.parse({
  asOf: "2026-10-16",
  sources: [
    "https://platform.claude.com/docs/en/about-claude/pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
  ],
  models: {
    "claude-haiku-5-5": {
      input_per_mtok: 0.1,
      output_per_mtok: 0.5,
      cache_read_per_mtok: 0.01,
      cache_write_per_mtok: 0.125,
    },
    "claude-sonnet-5-5": {
      input_per_mtok: 2.0,
      output_per_mtok: 10.0,
      cache_read_per_mtok: 0.1,
      cache_write_per_mtok: 2.5,
    },
    "claude-opus-5-5": {
      input_per_mtok: 4.0,
      output_per_mtok: 20.0,
      cache_read_per_mtok: 0.2,
      cache_write_per_mtok: 5.0,
    },
    "gemini-3.8-flash": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
      cache_read_per_mtok: 0.075,
    },
  },
});

describe("pricing: calculateCostUsd token math", () => {
  it("calculates cost accurately using (input*in + output*out + cread*cr + cwrite*cw)/1M", () => {
    // 100k input, 50k output, 200k cache_read, 10k cache_write on claude-sonnet-5-5
    // (100000 * 2.0 + 50000 * 10.0 + 200000 * 0.1 + 10000 * 2.5) / 1_000_000
    // = (200000 + 500000 + 20000 + 25000) / 1_000_000 = 745000 / 1_000_000 = 0.745
    const res = calculateCostUsd(S4_PRICING, "claude-sonnet-5-5", {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_tokens: 200_000,
      cache_write_tokens: 10_000,
    });
    expect(res.cost_source).toBe("computed");
    expect(res.cost_usd).toBeCloseTo(0.745, 6);
  });

  it("handles missing cache tokens by defaulting to 0 without crashing", () => {
    // 500k input, 100k output on claude-haiku-5-5
    // (500000 * 0.1 + 100000 * 0.5) / 1_000_000 = (50000 + 50000) / 1_000_000 = 0.10
    const res = calculateCostUsd(S4_PRICING, "claude-haiku-5-5", {
      input_tokens: 500_000,
      output_tokens: 100_000,
    });
    expect(res.cost_source).toBe("computed");
    expect(res.cost_usd).toBeCloseTo(0.10, 6);
  });

  it("calculates cost accurately for gemini-3.8-flash", () => {
    // 1M input, 100k output, 500k cache_read
    // (1000000 * 0.75 + 100000 * 3.75 + 500000 * 0.075) / 1M = (750000 + 375000 + 37500) / 1M = 1.1625
    const res = calculateCostUsd(S4_PRICING, "gemini-3.8-flash", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_tokens: 500_000,
    });
    expect(res.cost_source).toBe("computed");
    expect(res.cost_usd).toBeCloseTo(1.1625, 6);
  });

  it("returns {cost_usd: 0, cost_source: 'unknown'} when model is not listed in PricingTable", () => {
    const res = calculateCostUsd(S4_PRICING, "unlisted-model-xyz", {
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(res.cost_source).toBe("unknown");
    expect(res.cost_usd).toBe(0);
  });

  it("rejects negative or NaN token counts", () => {
    expect(() =>
      calculateCostUsd(S4_PRICING, "claude-sonnet-5-5", {
        input_tokens: -100,
        output_tokens: 50,
      }),
    ).toThrow();

    expect(() =>
      calculateCostUsd(S4_PRICING, "claude-sonnet-5-5", {
        input_tokens: NaN,
        output_tokens: 50,
      }),
    ).toThrow();
  });
});

describe("pricing: calculateCostUsd record assembly", () => {
  it("populates cost_usd and marks cost_source as 'computed'", () => {
    const raw = {
      backend: "claude" as const,
      model: "claude-sonnet-5-5",
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_tokens: 200_000,
      cache_write_tokens: 10_000,
      at: nowIsoTimestamp(),
    };

    const { cost_usd, cost_source } = calculateCostUsd(S4_PRICING, raw.model, raw);
    const record = { ...raw, cost_usd, cost_source };

    expect(record.cost_source).toBe("computed");
    expect(record.cost_usd).toBeCloseTo(0.745, 6);
    expect(record.backend).toBe("claude");
    expect(record.model).toBe("claude-sonnet-5-5");

    // Must validate successfully against authoritative UsageRecord schema
    expect(() => Contracts.UsageRecord.parse(record)).not.toThrow();
  });
});
