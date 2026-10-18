import type { PricingTable, Settings, UsageRecord } from "../contracts/index.js";
import { UsageRecord as UsageRecordSchema } from "../contracts/index.js";
import { DEFAULT_PRICING } from "./default-pricing.js";

export function pricingTableFor(settings: Settings): PricingTable {
  const models = { ...DEFAULT_PRICING.models };
  if (settings.pricing?.models) {
    for (const [modelId, rates] of Object.entries(settings.pricing.models)) {
      if (rates) {
        models[modelId] = rates;
      }
    }
  }
  return {
    asOf: settings.pricing?.asOf ?? DEFAULT_PRICING.asOf,
    sources: settings.pricing?.sources ?? DEFAULT_PRICING.sources,
    models,
  };
}

export function calculateCostUsd(
  pricing: PricingTable,
  model: string,
  tokens: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  }
): { cost_usd: number; cost_source: "computed" | "unknown" } {
  if (
    typeof tokens.input_tokens !== "number" ||
    Number.isNaN(tokens.input_tokens) ||
    tokens.input_tokens < 0 ||
    !Number.isFinite(tokens.input_tokens)
  ) {
    throw new Error(`Invalid input_tokens: ${tokens.input_tokens}`);
  }
  if (
    typeof tokens.output_tokens !== "number" ||
    Number.isNaN(tokens.output_tokens) ||
    tokens.output_tokens < 0 ||
    !Number.isFinite(tokens.output_tokens)
  ) {
    throw new Error(`Invalid output_tokens: ${tokens.output_tokens}`);
  }
  if (tokens.cache_read_tokens !== undefined) {
    if (
      typeof tokens.cache_read_tokens !== "number" ||
      Number.isNaN(tokens.cache_read_tokens) ||
      tokens.cache_read_tokens < 0 ||
      !Number.isFinite(tokens.cache_read_tokens)
    ) {
      throw new Error(`Invalid cache_read_tokens: ${tokens.cache_read_tokens}`);
    }
  }
  if (tokens.cache_write_tokens !== undefined) {
    if (
      typeof tokens.cache_write_tokens !== "number" ||
      Number.isNaN(tokens.cache_write_tokens) ||
      tokens.cache_write_tokens < 0 ||
      !Number.isFinite(tokens.cache_write_tokens)
    ) {
      throw new Error(`Invalid cache_write_tokens: ${tokens.cache_write_tokens}`);
    }
  }

  const rates = pricing?.models ? pricing.models[model] : undefined;
  if (!rates) {
    return { cost_usd: 0, cost_source: "unknown" };
  }

  const inputCost = tokens.input_tokens * rates.input_per_mtok;
  const outputCost = tokens.output_tokens * rates.output_per_mtok;
  const cacheReadCost =
    rates.cache_read_per_mtok !== undefined
      ? (tokens.cache_read_tokens ?? 0) * rates.cache_read_per_mtok
      : 0;
  const cacheWriteCost =
    rates.cache_write_per_mtok !== undefined
      ? (tokens.cache_write_tokens ?? 0) * rates.cache_write_per_mtok
      : 0;

  const cost_usd = (inputCost + outputCost + cacheReadCost + cacheWriteCost) / 1_000_000;
  return { cost_usd, cost_source: "computed" };
}

export function computeUsageRecord(
  pricing: PricingTable,
  raw: Omit<UsageRecord, "cost_usd" | "cost_source">
): UsageRecord {
  const { cost_usd, cost_source } = calculateCostUsd(pricing, raw.model, raw);
  const record = {
    ...raw,
    cost_usd,
    cost_source,
  };
  return UsageRecordSchema.parse(record);
}
