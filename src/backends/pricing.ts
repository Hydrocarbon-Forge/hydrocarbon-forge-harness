import type { PricingTable, Settings } from "../contracts/index.js";
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

const EFFORT_SUFFIX = /-(low|medium|high)$/;

/**
 * Rates for a model id: an exact key wins; otherwise one trailing effort tier is
 * stripped and the base id's rates are used, but only when the base is priced.
 * Never invents a price. Object.hasOwn keeps prototype keys (constructor) unpriced.
 */
export function ratesFor(
  id: string,
  models: PricingTable["models"],
): PricingTable["models"][string] | undefined {
  if (Object.hasOwn(models, id)) return models[id];
  const m = EFFORT_SUFFIX.exec(id);
  if (!m) return undefined;
  const base = id.slice(0, -m[0].length);
  return Object.hasOwn(models, base) ? models[base] : undefined;
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

  const rates = pricing?.models ? ratesFor(model, pricing.models) : undefined;
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
