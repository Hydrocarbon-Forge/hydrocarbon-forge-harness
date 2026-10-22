import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest, Settings } from "../../../src/contracts/index.js";
import { lintPlan, type LintOptions } from "../../../src/spec/linter.js";
import type { ParsedPlan, ParsedTaskSpec } from "../../../src/spec/parser.js";
import {
  createTempRepo,
  sampleManifest,
  sampleParsedPlan,
  sampleParsedTaskSpec,
  sampleSettings,
  sampleTaskSpecFrontmatter,
} from "./fixtures.js";

// R12.3: plan lint blocks only a plan that cannot run. A blocker is an error and refuses the plan (one
// planner retry). Every other rule is a warning: the same defect yields a warning, never an error.

/** A repository where a one-task plan lints clean: the contract file exists and every verify passes. */
function cleanRepo(): string {
  const repo = createTempRepo();
  mkdirSync(join(repo, "src", "contracts"), { recursive: true });
  writeFileSync(join(repo, "src", "contracts", "index.ts"), "export {};\n", "utf8");
  return repo;
}

function fmFor(id: string, over: Record<string, unknown> = {}) {
  return sampleTaskSpecFrontmatter({
    id: id as any,
    read: ["src/contracts/index.ts"],
    create: [`src/${id.toLowerCase()}.ts`],
    protected: [],
    verify: [{ run: "node -e 'process.exit(0)'", timeout_s: 30 }],
    ...over,
  } as any);
}

interface TaskDef {
  id: string;
  fm?: Record<string, unknown>;
  sections?: Map<string, string>;
  /** Write the task's spec file to disk (default true). */
  onDisk?: boolean;
  /** The spec path the manifest names (default tasks/<id>.md). */
  spec?: string;
}

/** A plan of the given tasks in repo. Each task's spec file is written unless onDisk is false. */
function planOf(repo: string, tasks: TaskDef[], manifest: Partial<Manifest> = {}): ParsedPlan {
  const manifestTasks = tasks.map((t) => ({ id: t.id as any, spec: t.spec ?? `tasks/${t.id}.md` }));
  const specs: ParsedTaskSpec[] = tasks.map((t) => {
    if (t.onDisk !== false && t.spec === undefined) {
      writeFileSync(join(repo, "tasks", `${t.id}.md`), "spec\n", "utf8");
    }
    return sampleParsedTaskSpec({
      frontmatter: fmFor(t.id, t.fm),
      filePath: t.spec ?? `tasks/${t.id}.md`,
      ...(t.sections ? { sections: t.sections } : {}),
    });
  });
  return sampleParsedPlan({
    manifest: sampleManifest({ tasks: manifestTasks, ...manifest }),
    specs,
  });
}

function oneTask(repo: string, fm: Record<string, unknown> = {}, manifest: Partial<Manifest> = {}, sections?: Map<string, string>) {
  return planOf(repo, [{ id: "T1", fm, ...(sections ? { sections } : {}) }], manifest);
}

function sectionsWith(overrides: Record<string, string>): Map<string, string> {
  const base = new Map<string, string>([
    ["Objective", "Build the feature."],
    ["Interface", "```ts\nexport declare function f(): void;\n```"],
    ["Behavior", "The feature runs."],
    ["Invariants", "Nothing else changes."],
    ["Edge cases", "Empty input is handled."],
    ["Guardrails", "Stay in the write set."],
    ["Out of scope", "Everything else."],
  ]);
  for (const [k, v] of Object.entries(overrides)) base.set(k, v);
  return base;
}

interface Row {
  code: string;
  /** The severity a defect of this rule must yield. */
  severity: "error" | "warn";
  defect: string;
  build: (repo: string) => { plan: ParsedPlan; settings?: Settings };
  options?: LintOptions;
}

const BLOCKERS: Row[] = [
  {
    code: "L001",
    severity: "error",
    defect: "the manifest fails its schema",
    build: (repo) => {
      const plan = oneTask(repo);
      (plan.manifest as any).run_id = "invalid-run-id";
      return { plan };
    },
  },
  {
    code: "L002",
    severity: "error",
    defect: "a duplicate task id",
    build: (repo) => {
      const plan = planOf(repo, [{ id: "T1" }]);
      plan.manifest.tasks.push({ id: "T1" as any, spec: "tasks/T1.md" });
      return { plan };
    },
  },
  {
    code: "L002",
    severity: "error",
    defect: "a task id that is not a valid id",
    build: (repo) => {
      const plan = planOf(repo, [{ id: "T1" }]);
      plan.manifest.tasks[0] = { id: "bad_id" as any, spec: "tasks/T1.md" };
      return { plan };
    },
  },
  {
    code: "L003",
    severity: "error",
    defect: "a declared spec file that is missing on disk",
    build: (repo) => ({ plan: planOf(repo, [{ id: "T1", spec: "tasks/missing.md" }]) }),
  },
  {
    code: "L004",
    severity: "error",
    defect: "depends_on names an unknown task",
    build: (repo) => ({ plan: oneTask(repo, { depends_on: ["NOPE"] }) }),
  },
  {
    code: "L005",
    severity: "error",
    defect: "a dependency cycle",
    build: (repo) => ({
      plan: planOf(repo, [
        { id: "T1", fm: { depends_on: ["T2"] } },
        { id: "T2", fm: { depends_on: ["T1"] } },
      ]),
    }),
  },
  {
    code: "L006",
    severity: "error",
    defect: "a contract file outside the repository",
    build: (repo) => ({
      plan: oneTask(repo, {}, { contracts: { files: ["../outside.ts"], typecheck: [] } }),
    }),
  },
];

const WARNINGS: Row[] = [
  {
    code: "L003",
    severity: "warn",
    defect: "an orphan spec file under tasks/",
    build: (repo) => {
      writeFileSync(join(repo, "tasks", "orphan.md"), "orphan\n", "utf8");
      return { plan: oneTask(repo) };
    },
  },
  {
    code: "L006",
    severity: "warn",
    defect: "a write path that escapes the repository",
    build: (repo) => ({ plan: oneTask(repo, { write: ["../escaped.txt"] }) }),
  },
  {
    code: "L007",
    severity: "warn",
    defect: "a write pattern that matches no file at base",
    build: (repo) => ({ plan: oneTask(repo, { write: ["src/nothing-here.ts"] }) }),
  },
  {
    code: "L008",
    severity: "warn",
    defect: "two tasks in one DAG layer that write the same path",
    build: (repo) => ({
      plan: planOf(repo, [
        { id: "T1", fm: { create: ["src/shared.ts"] } },
        { id: "T2", fm: { create: ["src/shared.ts"] } },
      ]),
    }),
  },
  {
    code: "L009",
    severity: "warn",
    defect: "a task that writes a path another task protects",
    build: (repo) => ({
      plan: planOf(repo, [
        { id: "T1", fm: { protected: ["src/shared.ts"] } },
        { id: "T2", fm: { create: ["src/shared.ts"] } },
      ]),
    }),
  },
  {
    code: "L010",
    severity: "warn",
    defect: "a verify list that is empty",
    build: (repo) => ({ plan: oneTask(repo, { verify: [] }) }),
  },
  {
    code: "L011",
    severity: "warn",
    defect: "a verify binary that cannot be resolved",
    build: (repo) => ({
      plan: oneTask(repo, { verify: [{ run: "definitely-not-a-binary-xyz --x", timeout_s: 10 }] }),
    }),
  },
  {
    code: "L011",
    severity: "warn",
    defect: "a verify cwd that does not exist",
    build: (repo) => ({
      plan: oneTask(repo, { verify: [{ run: "node -e 'process.exit(0)'", cwd: "no_such_dir", timeout_s: 10 }] }),
    }),
  },
  {
    code: "L012",
    severity: "warn",
    defect: "a verify that names a test path nothing provides",
    build: (repo) => ({
      plan: oneTask(repo, { verify: [{ run: "node --test test/unit/missing.test.js", timeout_s: 10 }] }),
    }),
  },
  {
    code: "L013",
    severity: "warn",
    defect: "a placeholder token in Behavior",
    build: (repo) => ({ plan: oneTask(repo, {}, undefined, sectionsWith({ Behavior: "TODO: describe it" })) }),
  },
  {
    code: "L014",
    severity: "warn",
    defect: "a required section that is empty",
    build: (repo) => ({ plan: oneTask(repo, {}, undefined, sectionsWith({ "Edge cases": "" })) }),
  },
  {
    code: "L016",
    severity: "warn",
    defect: "a task budget above the per-task cap",
    build: (repo) => ({
      plan: oneTask(repo, { budget: { max_usd: 0.25 } }),
      settings: sampleSettings({ budgets: { task: { max_usd: 0.1 } } } as any),
    }),
  },
  {
    code: "L017",
    severity: "warn",
    defect: "a read set above the context budget",
    build: (repo) => ({ plan: oneTask(repo) }),
    options: { contextBudgetBytes: 1 },
  },
  {
    code: "L018",
    severity: "warn",
    defect: "a contract typecheck that fails",
    build: (repo) => ({
      plan: oneTask(repo, {}, { contracts: { files: ["src/contracts/index.ts"], typecheck: [{ run: "node -e 'process.exit(1)'", timeout_s: 10 }] } }),
    }),
  },
  {
    code: "L019",
    severity: "warn",
    defect: "an Interface that names an undeclared contract file",
    build: (repo) => ({
      plan: oneTask(repo, {}, undefined, sectionsWith({ Interface: "Uses src/contracts/extra.ts for types." })),
    }),
  },
  {
    code: "L020",
    severity: "warn",
    defect: "a code fence with an implementation body",
    build: (repo) => {
      const plan = planOf(repo, [{ id: "T1" }]);
      const spec = plan.specs.get("T1" as any)!;
      spec.codeBlocks = [{ lang: "ts", code: "for (const x of y) { return x; }", lineStart: 1, lineCount: 1 }];
      return { plan };
    },
  },
  {
    code: "L021",
    severity: "warn",
    defect: "an empty integration_verify",
    build: (repo) => ({ plan: oneTask(repo, {}, { integration_verify: [] }) }),
  },
  {
    code: "L023",
    severity: "warn",
    defect: "a verify that passes at base",
    build: (repo) => ({ plan: oneTask(repo), settings: sampleSettings({ lint: { red_check: true } }) }),
  },
  {
    code: "L024",
    severity: "warn",
    defect: "class tests that writes a non-test path",
    build: (repo) => ({ plan: oneTask(repo, { class: "tests", write: ["src/feature.ts"] }) }),
  },
  {
    code: "L025",
    severity: "warn",
    defect: "a manifest budget above the run cap",
    build: (repo) => ({
      plan: oneTask(repo, {}, { budget: { max_usd: 2 } } as any),
      settings: sampleSettings({ budgets: { run: { max_usd: 0.5 } } } as any),
    }),
  },
  {
    code: "L026",
    severity: "warn",
    defect: "more tasks than the maximum",
    build: (repo) => ({ plan: planOf(repo, [{ id: "T1" }, { id: "T2" }]) }),
    options: { maxTasks: 1 },
  },
  {
    code: "L027",
    severity: "warn",
    defect: "a protected path that does not exist at base",
    build: (repo) => ({ plan: oneTask(repo, { protected: ["src/absent.ts"] }) }),
  },
  {
    code: "L028",
    severity: "warn",
    defect: "a tests task with more than 10 test targets",
    build: (repo) => {
      const items = Array.from({ length: 11 }, (_, i) => `${i + 1}. case ${i + 1}`).join("\n");
      return { plan: oneTask(repo, { class: "tests" }, undefined, sectionsWith({ Behavior: items })) };
    },
  },
];

async function lint(row: Row) {
  const repo = cleanRepo();
  const built = row.build(repo);
  return lintPlan(built.plan, repo, built.settings ?? sampleSettings(), row.options ?? {});
}

describe("R12.3: a blocker is an error; every other rule's defect is a warning", () => {
  it.each(BLOCKERS.map((r) => [r.code, r.defect, r] as const))("%s blocks: %s", async (code, _defect, row) => {
    const result = await lint(row);
    const diag = result.diagnostics.find((d) => d.code === code && d.severity === "error");
    expect(diag, JSON.stringify(result.diagnostics)).toBeDefined();
    expect(result.hasErrors).toBe(true);
    expect(result.ok).toBe(false);
  });

  it.each(WARNINGS.map((r) => [r.code, r.defect, r] as const))("%s warns, never blocks: %s", async (code, _defect, row) => {
    const result = await lint(row);
    const diag = result.diagnostics.find((d) => d.code === code);
    expect(diag, JSON.stringify(result.diagnostics)).toBeDefined();
    expect(diag?.severity).toBe("warn");
    expect(result.diagnostics.filter((d) => d.code === code && d.severity === "error")).toEqual([]);
  });

  it("a plan whose only diagnostics are warnings is ok: it has no blocker", async () => {
    const repo = cleanRepo();
    const plan = oneTask(repo, { write: ["src/nothing-here.ts"], verify: [{ run: "definitely-not-a-binary-xyz", timeout_s: 10 }] });
    const result = await lintPlan(plan, repo, sampleSettings());
    expect(result.diagnostics.filter((d) => d.severity === "warn").length).toBeGreaterThan(0);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.hasErrors).toBe(false);
  });

  it("a task class the router does not name is not a blocker: the plan lints without an error", async () => {
    const repo = cleanRepo();
    const result = await lintPlan(oneTask(repo, { class: "mystery-class" }), repo, sampleSettings());
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
