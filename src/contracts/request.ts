import { z } from "zod";
import { Effort, PermissionMode } from "./index.js";

export const RoleRequest = z
  .object({
    provider: z.enum(["claude", "opencode", "agy"]),
    model: z.string().optional(),
    effort: Effort.optional(),
  })
  .strict();
export type RoleRequest = z.infer<typeof RoleRequest>;

// Spend, token and time caps were removed (owner, 2026-10-23). A request's `budget` object is still accepted so an
// older caller is not refused, and it is ignored: no run, task or harness reads it.
export const RunBudget = z.record(z.string(), z.unknown());
export type RunBudget = z.infer<typeof RunBudget>;

export const RunRequest = z
  .object({
    goal: z.string().refine((s) => s.trim().length > 0, {
      message: "goal must not be empty",
    }),
    planner: RoleRequest.optional(),
    worker: RoleRequest.optional(),
    mode: z.enum(["auto", "solo", "plan"]).optional(),
    verify: z
      .array(
        z.string().refine((s) => s.trim().length > 0, {
          message: "verify command must not be empty",
        })
      )
      .optional(),
    budget: RunBudget.optional(),
    permission_mode: PermissionMode.optional(),
    context: z.array(z.string()).optional(),
    // Merge the run into the checked-out branch when it passes, for this run only (R7.4).
    merge: z.boolean().optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequest>;
