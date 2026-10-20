// Plan-mode scenario builders shared by the matrix and the requested-models tests: a
// manifest, task specs with the spec sections the engine checks, and the planner's
// file set (manifest, tasks and the contract stub).

export const CONTRACT_STUB = "export {};\n";

export function manifestFor(goal: string, taskIds: string[], integrationCmd = "echo verify all"): string {
  return [
    "version: 1",
    "run_id: r_MATRIXRUNABC",
    `goal: ${goal}`,
    "base_ref: main",
    "ecosystem: node-ts",
    "setup:",
    "  - run: echo setup",
    "    timeout_s: 30",
    "contracts:",
    "  files:",
    "    - contracts/types.ts",
    "  typecheck:",
    "    - run: echo typecheck contracts",
    "      timeout_s: 30",
    "integration_verify:",
    `  - run: ${integrationCmd}`,
    "    timeout_s: 60",
    "tasks:",
    ...taskIds.flatMap((id) => [`  - id: ${id}`, `    spec: tasks/${id}.md`]),
    "",
  ].join("\n");
}

export function taskSpec(o: {
  id: string;
  title?: string;
  dependsOn?: string[];
  write: string[];
  create?: string[];
  protectedPaths?: string[];
  verify: string;
  budget?: string[];
  marker?: string;
}): string {
  const protectedPaths = o.protectedPaths ?? [];
  return [
    "---",
    `id: ${o.id}`,
    `title: ${o.title ?? `Edit the allowed file for ${o.id}`}`,
    "class: feature",
    `depends_on: [${(o.dependsOn ?? []).join(", ")}]`,
    "read:",
    "  - contracts/types.ts",
    o.write.length > 0 ? "write:" : "write: []",
    ...o.write.map((p) => `  - ${p}`),
    o.create && o.create.length > 0 ? "create:" : "create: []",
    ...(o.create ?? []).map((p) => `  - ${p}`),
    protectedPaths.length > 0 ? "protected:" : "protected: []",
    ...protectedPaths.map((p) => `  - ${p}`),
    "budget:",
    ...(o.budget ?? ["  max_usd: 0.5", "  max_turns: 12"]),
    "verify:",
    `  - run: ${o.verify}`,
    "    timeout_s: 10",
    "---",
    "",
    "## Objective",
    "",
    `Write one line in the allowed file for ${o.id} and nothing else.`,
    ...(o.marker ? ["", `Spec marker: ${o.marker}.`] : []),
    "",
    "## Interface",
    "",
    "The allowed file gains the marker line.",
    "",
    "## Behavior",
    "",
    "The marker line is present after the task runs.",
    "",
    "## Invariants",
    "",
    "No other file is modified.",
    "",
    "## Edge cases",
    "",
    "The file is not rewritten, only appended.",
    "",
    "## Guardrails",
    "",
    "No network access.",
    "",
    "## Out of scope",
    "",
    "Renaming the file.",
    "",
  ].join("\n");
}

export function planCall(files: Record<string, string>, reply = "PLAN READY"): Record<string, unknown> {
  return { plan: { files }, reply: `wrote the plan for the matrix\n${reply}` };
}

export function contractFiles(manifest: string, tasks: Record<string, string>): Record<string, string> {
  return { "manifest.yaml": manifest, ...tasks, "contracts/types.ts": CONTRACT_STUB };
}

