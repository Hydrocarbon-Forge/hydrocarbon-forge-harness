import type { PricingTable } from "../contracts/index.js";

export const DEFAULT_PRICING: PricingTable = {
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
    "claude-opus-5-5": {
      input_per_mtok: 4,
      output_per_mtok: 20,
      cache_read_per_mtok: 0.2,
      cache_write_per_mtok: 5,
    },
    "claude-sonnet-5-5": {
      input_per_mtok: 2,
      output_per_mtok: 10,
      cache_read_per_mtok: 0.1,
      cache_write_per_mtok: 2.5,
    },
    "gemini-3.8-flash": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
      cache_read_per_mtok: 0.075,
    },
  },
};
