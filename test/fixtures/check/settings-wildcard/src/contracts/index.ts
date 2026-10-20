import { z } from "zod";

export const Settings = z.object({
  pricing: z.object({
    models: z.record(
      z.object({
        input_per_mtok: z.number(),
        // Seeded true positive: never read anywhere in src/.
        unused_rate: z.number(),
      }),
    ),
  }),
  routing: z.record(
    z.object({
      model: z.string(),
      // Seeded true positive: never read anywhere in src/.
      bogus_field: z.string(),
    }),
  ),
});
