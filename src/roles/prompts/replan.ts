import type { FailurePacket } from "../../contracts/index.js";

import { assembleSystem, loadTemplate } from "../../prompts/index.js";
import { render } from "../../prompts/render.js";

function failureDetails(packet: FailurePacket): string {
  const lines: string[] = [];
  for (const v of packet.verify_output) {
    lines.push(`- ${v.cmd} (exit ${v.exit_code})`);
    if (v.stdout_tail) {
      lines.push(`  stdout tail: ${v.stdout_tail}`);
    }
    if (v.stderr_tail) {
      lines.push(`  stderr tail: ${v.stderr_tail}`);
    }
  }
  for (const p of packet.scope_violations) {
    lines.push(`- scope violation: ${p}`);
  }
  return lines.length > 0 ? lines.join("\n") : "";
}

// Every value here is data from the packet or supplied by the engine; the wording comes
// from the templates in assets/prompts/planner.
function listLines(values: string[]): string {
  return values.map((v) => `- ${v}`).join("\n");
}

function diffSummary(packet: FailurePacket): string {
  return packet.diff.truncated ? `${packet.diff.stat} (truncated)` : packet.diff.stat;
}

export function buildReplanPrompt(
  packet: FailurePacket,
  decisionsLog?: string,
  vars: Record<string, string> = {},
): {
  system: string;
  user: string;
} {
  const system = assembleSystem("planner", {});

  const user = render(loadTemplate("planner/replan-l1.md"), {
    task_id: packet.task_id,
    generation: String(packet.generation),
    failure_class: packet.failure_class,
    spec_path: packet.spec_path,
    failure_details: failureDetails(packet),
    diff_summary: diffSummary(packet),
    worker_summary: packet.worker_summary,
    task_spec: "",
    related_contracts: listLines(packet.related_contracts),
    dependents: listLines(packet.dependents),
    decisions: decisionsLog ?? "",
    ...vars,
  });

  return { system, user };
}

export function buildReplanL2Prompt(
  packet: FailurePacket,
  vars: Record<string, string> = {},
): {
  system: string;
  user: string;
} {
  const system = assembleSystem("planner", {});

  const user = render(loadTemplate("planner/replan-l2.md"), {
    task_id: packet.task_id,
    failure_class: packet.failure_class,
    escalation_reason: "",
    failure_details: failureDetails(packet),
    worker_summary: packet.worker_summary,
    manifest: "",
    task_states: "",
    contracts: "",
    decisions: "",
    ...vars,
  });

  return { system, user };
}
