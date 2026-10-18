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

export function buildReplanPrompt(
  packet: FailurePacket,
  decisionsLog?: string,
): {
  system: string;
  user: string;
} {
  const system = assembleSystem("planner", {});

  const diffSummary: string[] = [`Stat: ${packet.diff.stat}`];
  if (packet.diff.truncated) {
    diffSummary.push("Notice: truncated");
  }

  const user = render(loadTemplate("planner/replan-l1.md"), {
    task_id: packet.task_id,
    generation: String(packet.generation),
    failure_class: packet.failure_class,
    spec_path: packet.spec_path,
    failure_details: failureDetails(packet),
    diff_summary: diffSummary.join("\n"),
    worker_summary: packet.worker_summary,
    task_spec: "",
    related_contracts: packet.related_contracts.length > 0
      ? packet.related_contracts.map((c) => `- ${c}`).join("\n")
      : "",
    dependents: packet.dependents.length > 0
      ? packet.dependents.map((d) => `- ${d}`).join("\n")
      : "",
    decisions: decisionsLog ?? "",
  });

  return { system, user };
}
