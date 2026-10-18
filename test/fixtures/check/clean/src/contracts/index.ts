import { z } from "zod";

export const Settings = z.object({
  feature: z.object({
    enabled: z.boolean(),
  }),
});
