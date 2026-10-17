import type { HookResult } from "./types.js";

export interface HookGateResult {
  proceed: boolean;
  blockedBy?: HookResult;
  feedback?: string;
}

export function evaluateHookGate(
  event: "PostPlan" | "PreMerge" | "PreRun" | "PreTask",
  results: HookResult[]
): HookGateResult {
  for (const r of results) {
    if (r.blocked || r.exit_code === 2) {
      const feedback =
        r.stderr && r.stderr.trim().length > 0
          ? r.stderr
          : "Hook command exited with code 2 but emitted no stderr";
      return {
        proceed: false,
        blockedBy: r,
        feedback,
      };
    }
  }
  return { proceed: true };
}
