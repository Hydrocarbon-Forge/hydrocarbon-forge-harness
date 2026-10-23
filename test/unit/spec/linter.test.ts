import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Diagnostic } from "../../../src/contracts/index.js";
import {
  lintPlan,
  type LintOptions,
  type LintResult,
  type SemanticCheckHook,
} from "../../../src/spec/linter.js";
import {
  createTempRepo,
  sampleManifest,
  sampleTaskSpecFrontmatter,
  sampleParsedTaskSpec,
  sampleParsedPlan,
  sampleSettings,
} from "./fixtures.js";

describe("plan linter: lintPlan orchestration and aggregation", () => {
  it("returns ok: true, hasErrors: false on a fully valid plan", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // Create existing files required by the plan
    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    writeFileSync(join(repo, "src", "contracts", "index.ts"), "export type Foo = 1;", "utf8");
    writeFileSync(join(repo, "tasks", "T1.md"), "spec", "utf8");
    writeFileSync(join(repo, "tasks", "T2.md"), "spec", "utf8");
    writeFileSync(join(repo, "test", "t1.test.ts"), "test", "utf8");
    writeFileSync(join(repo, "test", "t2.test.ts"), "test", "utf8");

    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        read: ["src/contracts/index.ts"],
        write: [],
        create: ["src/feature/a.ts"],
        protected: ["src/contracts/index.ts"],
        verify: [{ run: "node -e 'process.exit(1)'", timeout_s: 30 }], // exits 1 (passes red-check)
      }),
      filePath: "tasks/T1.md",
    });

    const t2 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T2",
        depends_on: ["T1"],
        read: ["src/contracts/index.ts"],
        write: [],
        create: ["src/feature/b.ts"],
        protected: ["src/contracts/index.ts"],
        verify: [{ run: "node -e 'process.exit(1)'", timeout_s: 30 }], // exits 1 (passes red-check)
      }),
      filePath: "tasks/T2.md",
    });

    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        contracts: {
          files: ["src/contracts/index.ts"],
          typecheck: [{ run: "node -e 'process.exit(0)'", timeout_s: 30 }],
        },
        tasks: [
          { id: "T1", spec: "tasks/T1.md" },
          { id: "T2", spec: "tasks/T2.md" },
        ],
        budget: { max_usd: 1.0 },
      }),
      specs: [t1, t2],
    });

    const result = await lintPlan(plan, repo, settings);

    expect(result.ok).toBe(true);
    expect(result.hasErrors).toBe(false);
  });

  it("sets ok: false and hasErrors: true whenever error diagnostics are present", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    // Spec that depends on itself (L005 error; an unknown dependency is only a warning, L004)
    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        depends_on: ["T1"],
      }),
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({ tasks: [{ id: "T1", spec: "tasks/T1.md" }] }),
      specs: [t1],
    });

    const result = await lintPlan(plan, repo, settings);

    expect(result.ok).toBe(false);
    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("preserves ok: true when only warning diagnostics are emitted", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings({
      budgets: {
        ...sampleSettings().budgets,
      },
    });

    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    writeFileSync(join(repo, "src", "contracts", "index.ts"), "export type A = 1;", "utf8");
    writeFileSync(join(repo, "tasks", "T1.md"), "spec", "utf8");

    // L021 warning: empty integration_verify
    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        verify: [{ run: "node -e 'process.exit(1)'", timeout_s: 30 }],
      }),
      filePath: "tasks/T1.md",
    });

    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        budget: { max_usd: 5.0 }, // advisory: no rule compares it with a cap (owner, 2026-10-23)
        integration_verify: [], // triggers L021 warn
        contracts: {
          files: ["src/contracts/index.ts"],
          typecheck: [{ run: "node -e 'process.exit(0)'", timeout_s: 30 }],
        },
        tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      }),
      specs: [t1],
    });

    const result = await lintPlan(plan, repo, settings);

    const warnings = result.diagnostics.filter((d) => d.severity === "warn");
    expect(warnings.length).toBeGreaterThan(0);
    // If no errors, ok must be true
    expect(result.hasErrors).toBe(false);
    expect(result.ok).toBe(true);
  });

});

describe("plan linter: semantic check hook point (S001 - S004)", () => {
  it("invokes semanticHook when provided and attaches diagnostics with severity info", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();
    const plan = sampleParsedPlan();

    const mockSemanticDiagnostics: Diagnostic[] = [
      { code: "S001", severity: "info", message: "Ambiguity detected in spec" },
      { code: "S002", severity: "info", message: "Missing edge cases in behavior" },
      { code: "S003", severity: "info", message: "Potential contract mismatch" },
      { code: "S004", severity: "info", message: "Task scope appears too large" },
    ];

    const semanticHook: SemanticCheckHook = {
      runSemanticChecks: vi.fn().mockResolvedValue(mockSemanticDiagnostics),
    };

    const result = await lintPlan(plan, repo, settings, { semanticHook });

    expect(semanticHook.runSemanticChecks).toHaveBeenCalledTimes(1);
    expect(semanticHook.runSemanticChecks).toHaveBeenCalledWith(plan, repo);

    for (const code of ["S001", "S002", "S003", "S004"]) {
      const diag = result.diagnostics.find((d) => d.code === code);
      expect(diag).toBeDefined();
      expect(diag?.severity).toBe("info");
    }
  });

  it("ensures semantic diagnostics NEVER cause LintResult.ok to become false", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();

    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    writeFileSync(join(repo, "src", "contracts", "index.ts"), "export type A = 1;", "utf8");
    writeFileSync(join(repo, "tasks", "T1.md"), "spec", "utf8");

    const t1 = sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: "T1",
        verify: [{ run: "node -e 'process.exit(1)'", timeout_s: 30 }],
      }),
      filePath: "tasks/T1.md",
    });
    const plan = sampleParsedPlan({
      manifest: sampleManifest({
        contracts: {
          files: ["src/contracts/index.ts"],
          typecheck: [{ run: "node -e 'process.exit(0)'", timeout_s: 30 }],
        },
        tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      }),
      specs: [t1],
    });

    const semanticHook: SemanticCheckHook = {
      runSemanticChecks: vi.fn().mockResolvedValue([
        { code: "S001", severity: "info", message: "Advisory ambiguity notice" },
        { code: "S004", severity: "info", message: "Advisory task size notice" },
      ]),
    };

    const result = await lintPlan(plan, repo, settings, { semanticHook });

    expect(result.diagnostics.some((d) => d.code === "S001")).toBe(true);
    // Invariant: Advisory semantic diagnostics never block execution (ok remains true)
    expect(result.hasErrors).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("skips semantic evaluation when semanticHook option is omitted", async () => {
    const repo = createTempRepo();
    const settings = sampleSettings();
    const plan = sampleParsedPlan();

    const result = await lintPlan(plan, repo, settings);

    expect(result.diagnostics.some((d) => d.code.startsWith("S00"))).toBe(false);
  });
});
