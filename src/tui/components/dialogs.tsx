import type { Manifest, RunId, SessionId } from "../../contracts/index.js";
/* intra-tui */ import type { DialogState } from "../state/dialog.js";

export interface DialogsProps {
  dialog: DialogState;
  onApprove?: (approved: boolean) => void;
  onSelectSession?: (sessionId: SessionId) => void;
  onClose?: () => void;
}

export function formatPlanDialog(manifest: Manifest): string[] {
  return [
    "=== Plan Approval Gate ===",
    `Goal: ${manifest.goal}`,
    `Run ID: ${manifest.run_id}`,
    `Base Ref: ${manifest.base_ref}`,
    `Tasks (${manifest.tasks.length}):`,
    ...manifest.tasks.map((t) => `  - ${t.id}: ${t.spec}`),
    "Press Enter/y to approve, Esc/n to reject",
  ];
}

export function formatCostDialog(
  estimatedUsd: number,
  thresholdUsd: number
): string[] {
  return [
    "=== Cost Budget Threshold Gate ===",
    `Estimated Run Cost: $${estimatedUsd.toFixed(2)}`,
    `Budget Threshold:    $${thresholdUsd.toFixed(2)}`,
    "Press Enter/y to proceed, Esc/n to cancel",
  ];
}

export function formatMergeDialog(
  runId: RunId,
  branch: string,
  files: string[]
): string[] {
  return [
    "=== Integration Merge Gate ===",
    `Run ID: ${runId}`,
    `Target Branch: ${branch}`,
    `Changed Files (${files.length}):`,
    ...files.map((f) => `  - ${f}`),
    "Press Enter/y to merge, Esc/n to cancel",
  ];
}

export function formatSessionPickerDialog(
  sessions: SessionId[],
  selectedIndex: number
): string[] {
  if (sessions.length === 0) {
    return [
      "=== Session Picker ===",
      "No existing sessions found.",
      "Press Esc to dismiss",
    ];
  }
  return [
    "=== Session Picker ===",
    ...sessions.map((s, idx) =>
      idx === selectedIndex ? `> [x] ${s}` : `  [ ] ${s}`
    ),
    "Use Up/Down to navigate, Enter to select, Esc to cancel",
  ];
}

export function DialogOverlay(props: DialogsProps): string[] {
  const d = props.dialog;
  switch (d.type) {
    case "none":
      return [];
    case "approval_plan":
      return formatPlanDialog(d.manifest);
    case "approval_cost":
      return formatCostDialog(d.estimatedUsd, d.thresholdUsd);
    case "approval_merge":
      return formatMergeDialog(d.runId, d.branch, d.files);
    case "session_picker":
      return formatSessionPickerDialog(d.sessions, d.selectedIndex);
  }
}
