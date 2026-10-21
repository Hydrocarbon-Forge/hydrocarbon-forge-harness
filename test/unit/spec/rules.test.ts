import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { lintPlan } from "../../../src/spec/linter.js";
import {
  createTempRepo,
  sampleManifest,
  sampleTaskSpecFrontmatter,
  sampleParsedTaskSpec,
  sampleParsedPlan,
  sampleSettings,
  SAMPLE_REQUIRED_SECTIONS,
} from "./fixtures.js";

describe("plan linter rules: L001 - L010 (schema and DAG integrity)", () => {
  it("L001: emits error when manifest or spec frontmatter fails schema", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // Manifest missing run_id (schema violation)
    const badManifest = sampleManifest();
    (badManifest as any).run_id = "invalid-run-id";
    const plan = sampleParsedPlan({ manifest: badManifest });

    const result = await lintPlan(plan, repo, settings);
    expect(result.ok).toBe(false);
    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "L001" && d.severity === "error")).toBe(true);
  });

  it("L002: emits error on malformed or duplicate task IDs", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // Duplicate task ID in manifest
    const dupPlan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [
          { id: "T1", spec: "tasks/T1.md" },
          { id: "T1", spec: "tasks/T1_dup.md" },
        ],
      }),
    });
    const dupResult = await lintPlan(dupPlan, repo, settings);
    expect(dupResult.diagnostics.some((d) => d.code === "L002" && d.severity === "error")).toBe(true);

    // Malformed task ID (starts with lowercase or special symbol)
    const badIdPlan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [{ id: "badId_lower" as any, spec: "tasks/bad.md" }],
      }),
    });
    const badIdResult = await lintPlan(badIdPlan, repo, settings);
    expect(badIdResult.diagnostics.some((d) => d.code === "L002" && d.severity === "error")).toBe(true);
  });

  it("L003: emits error when a declared spec file is missing, and a warning when an orphan spec exists", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // Spec file missing on disk
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [{ id: "T1", spec: "tasks/missing_spec.md" }],
      }),
    });
    const resultMissing = await lintPlan(plan, repo, settings);
    expect(resultMissing.diagnostics.some((d) => d.code === "L003" && d.severity === "error")).toBe(true);

    // Orphan spec file exists in tasks/ directory
    writeFileSync(join(repo, "tasks", "orphan.md"), "orphan spec", "utf8");
    const validSpecPath = join(repo, "tasks", "T1.md");
    writeFileSync(validSpecPath, "spec content", "utf8");
    const validPlan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      }),
    });
    const resultOrphan = await lintPlan(validPlan, repo, settings);
    expect(resultOrphan.diagnostics.some((d) => d.code === "L003" && d.severity === "warn")).toBe(true);
  });

  it("L004: emits error when depends_on references an unknown task ID", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const specWithGhostDep = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        depends_on: ["GHOST_TASK"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [specWithGhostDep],
    });

    const result = await lintPlan(plan, repo, settings);
    expect(result.diagnostics.some((d) => d.code === "L004" && d.severity === "error")).toBe(true);
  });

  it("L005: emits error when task dependency graph has cycles", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // Self dependency
    const selfDepSpec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({ id: "T1", depends_on: ["T1"] }),
    });
    const selfDepPlan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [selfDepSpec],
    });
    const selfResult = await lintPlan(selfDepPlan, repo, settings);
    const diagSelf = selfResult.diagnostics.find((d) => d.code === "L005");
    expect(diagSelf).toBeDefined();
    expect(diagSelf?.severity).toBe("error");
    expect(diagSelf?.message).toContain("T1");

    // Mutual cycle: T1 -> T2 -> T1
    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({ id: "T1", depends_on: ["T2"] }),
    });
    const t2 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({ id: "T2", depends_on: ["T1"] }),
    });
    const mutualPlan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [
          { id: "T1", spec: "tasks/T1.md" },
          { id: "T2", spec: "tasks/T2.md" },
        ],
      }),
      specs: [t1, t2],
    });
    const mutualResult = await lintPlan(mutualPlan, repo, settings);
    expect(mutualResult.diagnostics.some((d) => d.code === "L005" && d.severity === "error")).toBe(true);
  });

  it("L006: emits warning when path escapes repository root", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const specWithEscape = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        read: ["/etc/passwd"],
        write: ["../escaped.txt"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [{ id: "T1", spec: "tasks/T1.md" }],
        contracts: {
          files: ["../../outside.ts"],
          typecheck: [{ run: "echo ok", timeout_s: 10, cwd: "/root" }],
        },
      }),
      specs: [specWithEscape],
    });

    const result = await lintPlan(plan, repo, settings);
    const diags = result.diagnostics.filter((d) => d.code === "L006");
    expect(diags.length).toBeGreaterThan(0);
    // A contract file outside the repository is a blocker; every other unsafe path is a warning.
    expect(diags.find((d) => d.path === "../../outside.ts")?.severity).toBe("error");
    expect(diags.find((d) => d.path === "../escaped.txt")?.severity).toBe("warn");
    expect(diags.find((d) => d.path === "/etc/passwd")?.severity).toBe("warn");
    expect(diags.filter((d) => d.path !== "../../outside.ts").every((d) => d.severity === "warn")).toBe(true);
  });

  it("L007: emits warning when spec.write pattern matches no existing files at base", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        write: ["src/does_not_exist_at_base.ts"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L007");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L008: emits warning when concurrent DAG-ready tasks have overlapping write/create sets", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    writeFileSync(join(repo, "src", "shared.ts"), "shared", "utf8");

    // T1 and T2 both at layer 0 (no depends_on) modifying same file
    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        depends_on: [],
        write: ["src/shared.ts"],
      }),
    });
    const t2 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T2",
        depends_on: [],
        write: ["src/shared.ts"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [
          { id: "T1", spec: "tasks/T1.md" },
          { id: "T2", spec: "tasks/T2.md" },
        ],
      }),
      specs: [t1, t2],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L008");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L009: emits warning when task write/create intersects another task protected patterns", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    writeFileSync(join(repo, "src", "contracts", "index.ts"), "types", "utf8");

    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        protected: ["src/contracts/**"],
      }),
    });
    // T2 is class "feature" attempting to write to protected contracts
    const t2 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T2",
        class: "feature",
        write: ["src/contracts/index.ts"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [
          { id: "T1", spec: "tasks/T1.md" },
          { id: "T2", spec: "tasks/T2.md" },
        ],
      }),
      specs: [t1, t2],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L009");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L010: emits warning when verify command is empty or missing", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        verify: [] as any,
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L010");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });
});

describe("plan linter rules: L011 - L020 (environment, sections, budgets, types)", () => {
  it("L011: emits warning when verify binary cannot be resolved or verify.cwd does not exist", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const specBadBin = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        verify: [{ run: "non_existent_binary_xyz_12345 --test", timeout_s: 10 }],
      }),
    });
    const planBadBin = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [specBadBin],
    });
    const resBadBin = await lintPlan(planBadBin, repo, settings);
    expect(resBadBin.diagnostics.some((d) => d.code === "L011" && d.severity === "warn")).toBe(true);

    const specBadCwd = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        verify: [{ run: "node -v", cwd: "invalid_dir_abc", timeout_s: 10 }],
      }),
    });
    const planBadCwd = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [specBadCwd],
    });
    const resBadCwd = await lintPlan(planBadCwd, repo, settings);
    expect(resBadCwd.diagnostics.some((d) => d.code === "L011" && d.severity === "warn")).toBe(true);
  });

  it("L012: emits warning when verify references uncreated and non-existent test path", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        verify: [{ run: "npm test -- test/unit/missing.test.ts", timeout_s: 30 }],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L012");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L013: emits warning when placeholder tokens appear in Interface or Behavior", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const sections = new Map(Object.entries(SAMPLE_REQUIRED_SECTIONS));
    sections.set("Behavior", "Step 1: TODO complete implementation.");

    const spec = sampleParsedTaskSpec({ sections });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L013");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L014: emits warning when any required section is missing or empty", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const sections = new Map(Object.entries(SAMPLE_REQUIRED_SECTIONS));
    sections.delete("Guardrails"); // Missing required section

    const spec = sampleParsedTaskSpec({ sections });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L014");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L015 is retired (R7.7): a class with no routing entry is routed by the fallback and lints clean", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings(); // routing has "feature"

    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        class: "unregistered_class",
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    expect(result.diagnostics.some((d) => d.code === "L015")).toBe(false);
  });

  // Changed (2026-10-21, owner): budgets are advisory and no cap is the default. The old tests pinned a
  // missing-budget warning and an error for an over-budget spec; both now depend on a per-task cap being set.
  it("L016 is silent with no per-task cap: no missing-budget warning and no over-budget diagnostic", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();
    const specNoBudget = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({ id: "T1", budget: undefined }),
    });
    const specOverBudget = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({ id: "T2", budget: { max_usd: 1.5 } }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [
          { id: "T1", spec: "tasks/T1.md" },
          { id: "T2", spec: "tasks/T2.md" },
        ],
      }),
      specs: [specNoBudget, specOverBudget],
    });

    const result = await lintPlan(plan, repo, settings);
    expect(result.diagnostics.filter((d) => d.code === "L016")).toEqual([]);
  });

  it("L016 warns (not an error) when a spec's budget estimate exceeds the per-task cap that is set", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings({
      budgets: {
        ...sampleSettings().budgets,
        task: { max_usd: 0.5 },
      },
    });

    const specOverBudget = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        budget: { max_usd: 1.5 }, // Exceeds 0.5
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [specOverBudget],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L016");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
    expect(diag?.message).toContain("exceeds the per-task cap");
    expect(result.diagnostics.filter((d) => d.code === "L016" && d.severity === "error")).toEqual([]);
  });

  it("L017: emits warning when task read set exceeds context budget cap", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // Create 60 files to exceed default cap of 50
    mkdirSync(join(repo, "src", "bulk"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(repo, "src", "bulk", `file_${i}.ts`), "content", "utf8");
    }

    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        read: ["src/bulk/*.ts"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L017");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L018: emits warning when contract typecheck command fails", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();
    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    writeFileSync(join(repo, "src", "contracts", "index.ts"), "export type A = 1;", "utf8");

    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        contracts: {
          files: ["src/contracts/index.ts"],
          typecheck: [{ run: "node -e 'process.exit(1)'", timeout_s: 10 }],
        },
      }),
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L018");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L019: emits warning when Interface references undeclared contract file", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const sections = new Map(Object.entries(SAMPLE_REQUIRED_SECTIONS));
    sections.set("Interface", "Import from `src/contracts/missing_types.ts`.");

    const spec = sampleParsedTaskSpec({ sections });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [{ id: "T1", spec: "tasks/T1.md" }],
        contracts: { files: ["src/contracts/index.ts"], typecheck: [] },
      }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L019");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L020: emits diagnostic when code fence contains implementation bodies", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const spec = sampleParsedTaskSpec({
      codeBlocks: [
        {
          lang: "ts",
          code: `
function executeProcess(input: string) {
  let acc = "";
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== " ") {
      acc += input[i];
    }
  }
  return acc;
}
`,
          lineStart: 12,
          lineCount: 10,
        },
      ],
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L020");
    expect(diag).toBeDefined();
  });
});

describe("plan linter rules: L021 - L027 (integration, cost gates, red-check, limits)", () => {
  it("L021: emits warning when manifest.integration_verify is empty", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        integration_verify: [],
      }),
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L021");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L022: emits gate diagnostic when estimated cost exceeds approval threshold", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings({
      budgets: {
        ...sampleSettings().budgets,
        approval_threshold_usd: 1.0,
      },
    });

    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        budget: { max_usd: 0.8 },
      }),
    });
    const t2 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T2",
        budget: { max_usd: 0.8 },
      }),
    });
    // Total = 1.6 > 1.0
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        tasks: [
          { id: "T1", spec: "tasks/T1.md" },
          { id: "T2", spec: "tasks/T2.md" },
        ],
      }),
      specs: [t1, t2],
    });

    const result = await lintPlan(plan, repo, settings);
    expect(result.hasGates).toBe(true);
    const diag = result.diagnostics.find((d) => d.code === "L022");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("gate");
  });

  it("L023: emits a warning, in every mode, when verify passes at base ref (red-check)", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        verify: [{ run: "node -e 'process.exit(0)'", timeout_s: 10 }],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    // L023 is a warning: a guess about the base never blocks a plan (it was an error under redCheck).
    const warnResult = await lintPlan(plan, repo, settings);
    const warnDiag = warnResult.diagnostics.find((d) => d.code === "L023");
    expect(warnDiag).toBeDefined();
    expect(warnDiag?.severity).toBe("warn");
  });

  it("L024: emits warning when class tests writes non-test or non-tests writes tests", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    writeFileSync(join(repo, "src", "code.ts"), "code", "utf8");
    writeFileSync(join(repo, "test", "unit.test.ts"), "test", "utf8");

    // tests-class writing src/code.ts
    const testsClassBad = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        class: "tests",
        write: ["src/code.ts"],
      }),
    });
    const plan1 = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [testsClassBad],
    });
    const res1 = await lintPlan(plan1, repo, settings);
    expect(res1.diagnostics.some((d) => d.code === "L024" && d.severity === "warn")).toBe(true);

    // feature-class writing test/unit.test.ts
    const featureClassBad = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T2",
        class: "feature",
        write: ["test/unit.test.ts"],
      }),
    });
    const plan2 = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T2", spec: "tasks/T2.md" }] }),
      specs: [featureClassBad],
    });
    const res2 = await lintPlan(plan2, repo, settings);
    expect(res2.diagnostics.some((d) => d.code === "L024" && d.severity === "warn")).toBe(true);
  });

  it("L025: emits warning when manifest budget exceeds run cap", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings({
      budgets: {
        ...sampleSettings().budgets,
        run: { max_usd: 5.0 },
      },
    });

    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        budget: { max_usd: 25.0 }, // Exceeds run max_usd 5.0
      }),
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L025");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L026: emits warning when total task count exceeds max_tasks limit", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // 5 tasks with maxTasks: 3
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `T${i + 1}`,
      spec: `tasks/T${i + 1}.md`,
    }));
    const specs = tasks.map((t) =>
      sampleParsedTaskSpec({
        frontmatter: sampleTaskSpecFrontmatter({ id: t.id }),
        filePath: t.spec,
      })
    );
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks }),
      specs,
    });

    const result = await lintPlan(plan, repo, settings, { maxTasks: 3 });
    const diag = result.diagnostics.find((d) => d.code === "L026");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });

  it("L027: emits warning when protected path does not exist at base and not created earlier", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        protected: ["src/missing_protected.ts"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, settings);
    const diag = result.diagnostics.find((d) => d.code === "L027");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("warn");
  });
});

describe("R7.7: lint rules that rejected a valid planner plan", () => {
  it("L018 typechecks the run directory, not a placeholder package.json at the repository root", async () => {
    // safeLoadPlan writes `export {};` for each contract file missing at the root; a
    // placeholder package.json there is not valid JSON and made Node fail at LINTING.
    const repo = createTempRepo();
    writeFileSync(join(repo, "package.json"), "export {};\n", "utf8");
    const runDir = mkdtempSync(join(tmpdir(), "substrate-r77-run-"));
    writeFileSync(join(runDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    writeFileSync(join(runDir, "game.js"), "export const game = 1;\n", "utf8");

    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        contracts: {
          files: ["game.js"],
          typecheck: [{ run: `node --input-type=module -e "await import('./game.js')"`, timeout_s: 30 }],
        },
      }),
      manifestPath: join(runDir, "manifest.yaml"),
    });

    const result = await lintPlan(plan, repo, sampleSettings());
    expect(result.diagnostics.filter((d) => d.code === "L018")).toEqual([]);
  });

  // The verify command the planner wrote in the first attempt of run r_XDZHITGE25FD.
  const GLOB_VERIFY = "sh -c 'node --test test/*.test.js; echo done'";

  it("L012 does not report a shell glob or the punctuation glued to a word", async () => {
    const repo = createTempRepo();
    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        create: ["test/game.test.js"],
        verify: [{ run: GLOB_VERIFY, timeout_s: 60 }],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, sampleSettings());
    expect(result.diagnostics.filter((d) => d.code === "L012")).toEqual([]);
  });

  it("L012 names a literal test path without the trailing semicolon, and still flags it when nothing provides it", async () => {
    const repo = createTempRepo();
    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        create: ["src/other.js"],
        verify: [{ run: "node --test test/missing.test.js; echo done", timeout_s: 60 }],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, sampleSettings());
    const diags = result.diagnostics.filter((d) => d.code === "L012");
    expect(diags.map((d) => d.path)).toEqual(["test/missing.test.js"]);
  });

  it("L012 is satisfied by a literal path that the task creates, even with a trailing semicolon", async () => {
    const repo = createTempRepo();
    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        create: ["test/game.test.js"],
        verify: [{ run: "node --check test/game.test.js; echo done", timeout_s: 60 }],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });

    const result = await lintPlan(plan, repo, sampleSettings());
    expect(result.diagnostics.filter((d) => d.code === "L012")).toEqual([]);
  });
});

describe("plan linter rule: L028 (test-target count, advisory)", () => {
  function behaviourWithTargets(count: number): string {
    return Array.from({ length: count }, (_, i) => `${i + 1}. Target ${i + 1} holds (reason ${i + 1}).`).join("\n");
  }

  function planWithBehaviour(classValue: string, count: number) {
    const repo = createTempRepo();
    const spec = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({ id: "T1", class: classValue }),
      sections: new Map(
        Object.entries({ ...SAMPLE_REQUIRED_SECTIONS, Behavior: behaviourWithTargets(count) }),
      ),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [spec],
    });
    return lintPlan(plan, repo, sampleSettings());
  }

  it("warns when a tests task lists more than 10 test targets, and names the count", async () => {
    const result = await planWithBehaviour("tests", 11);
    const diags = result.diagnostics.filter((d) => d.code === "L028");
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warn");
    expect(diags[0].task).toBe("T1");
    expect(diags[0].message).toBe(
      "Task T1 lists 11 test targets; keep the ones that carry risk (about 10 or fewer) and move the rest to Out of scope",
    );
  });

  it("is silent for a tests task with exactly 10 test targets", async () => {
    const result = await planWithBehaviour("tests", 10);
    expect(result.diagnostics.some((d) => d.code === "L028")).toBe(false);
  });

  it("is silent for a non-tests task whose Behavior has more than 10 numbered items", async () => {
    const result = await planWithBehaviour("feature", 12);
    expect(result.diagnostics.some((d) => d.code === "L028")).toBe(false);
  });
});
