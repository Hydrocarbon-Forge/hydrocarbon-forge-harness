import { z } from "zod";

export const Settings = z.object({
  unread_setting: z.string(),
});
