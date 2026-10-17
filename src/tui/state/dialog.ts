import type { Manifest, RunId, SessionId } from "../../contracts/index.js";

export type DialogState =
  | { type: "none" }
  | { type: "approval_plan"; manifest: Manifest }
  | { type: "approval_cost"; estimatedUsd: number; thresholdUsd: number }
  | { type: "approval_merge"; runId: RunId; branch: string; files: string[] }
  | { type: "session_picker"; sessions: SessionId[]; selectedIndex: number };
