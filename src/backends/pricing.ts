import type { PricingTable, UsageRecord } from "../contracts/index.js";
import { UsageRecord as UsageRecordSchema } from "../contracts/index.js";

export function calculateCostUsd(
  pricing: PricingTable,
  model: string,
  tokens: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  }
): number {
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

  const rates = pricing.models[model];
  if (!rates) {
    throw new Error(`Model "${model}" is unlisted in pricing table`);
  }

  const inputCost = tokens.input_tokens * rates.input_per_mtok;
  const outputCost = tokens.output_tokens * rates.output_per_mtok;
  const cacheReadCost = (tokens.cache_read_tokens ?? 0) * (rates.cache_read_per_mtok ?? 0);
  const cacheWriteCost = (tokens.cache_write_tokens ?? 0) * (rates.cache_write_per_mtok ?? 0);

  return (inputCost + outputCost + cacheReadCost + cacheWriteCost) / 1_000_000;
}

export function computeUsageRecord(
  pricing: PricingTable,
  raw: Omit<UsageRecord, "cost_usd" | "cost_source">
): UsageRecord {
  const cost = calculateCostUsd(pricing, raw.model, raw);
  const record = {
    ...raw,
    cost_usd: cost,
    cost_source: "computed" as const,
  };
  return UsageRecordSchema.parse(record);
}
