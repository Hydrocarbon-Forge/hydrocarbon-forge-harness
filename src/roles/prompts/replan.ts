import type { FailurePacket } from "../../contracts/index.js";

export function buildReplanPrompt(
  packet: FailurePacket,
  decisionsLog?: string,
): {
  system: string;
  user: string;
} {
  const system = [
    "You are the Substrate planner agent performing a failure replan.",
    "A prior worker execution failed verification or violated execution constraints.",
    "Analyze the failure packet and produce an amended plan, modified task specs, or adjusted contract stubs.",
  ].join("\n");

  const sections: string[] = [];

  sections.push(`## Failure Details`);
  sections.push(`- Task ID: ${packet.task_id}`);
  sections.push(`- Generation: ${packet.generation}`);
  sections.push(`- Failure Class: ${packet.failure_class}`);
  sections.push(`- Spec Path: ${packet.spec_path}`);

  if (packet.failure_class === "verify_failed") {
    sections.push(`### Verification Failures (failure_class: verify_failed)`);
    for (const v of packet.verify_output) {
      sections.push(
        [
          `Command: ${v.cmd}`,
          `exit_code: ${v.exit_code}`,
          `Duration: ${v.duration_ms}ms`,
          v.stdout_tail ? `Stdout Tail:\n${v.stdout_tail}` : "",
          v.stderr_tail ? `Stderr Tail:\n${v.stderr_tail}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  } else if (packet.failure_class === "scope_violation") {
    sections.push(`### Scope Violations (failure_class: scope_violation)`);
    sections.push(
      "The worker modified files outside its declared write/create scope. Narrow worker scope or update task specification accordingly.",
    );
    sections.push(
      `Offending paths:\n${packet.scope_violations.map((f) => `- ${f}`).join("\n")}`,
    );
  } else if (packet.failure_class === "protected_modified") {
    sections.push(`### Protected Files Modified (failure_class: protected_modified)`);
    sections.push(
      "The worker modified protected files. Protected files must remain strictly byte-identical and cannot be altered.",
    );
    if (packet.scope_violations.length > 0) {
      sections.push(
        `Modified protected paths:\n${packet.scope_violations.map((f) => `- ${f}`).join("\n")}`,
      );
    }
  }

  if (packet.diff) {
    sections.push(`### Patch Diff Summary`);
    sections.push(`Stat: ${packet.diff.stat}`);
    if (packet.diff.truncated) {
      sections.push("Notice: The patch diff was truncated due to size limits.");
    }
  }

  if (packet.worker_summary) {
    sections.push(`### Worker Summary (Untrusted capped context)`);
    sections.push(packet.worker_summary);
  }

  if (packet.related_contracts && packet.related_contracts.length > 0) {
    sections.push(
      `### Related Contracts\n${packet.related_contracts.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  if (decisionsLog) {
    sections.push(`## Prior Planner Decisions Log\n${decisionsLog}`);
  }

  return {
    system,
    user: sections.join("\n\n"),
  };
}
