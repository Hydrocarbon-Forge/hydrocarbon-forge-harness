import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { ingestPlanDraft } from "../../../src/roles/planner.js";
import { createRunId } from "../../../src/util/index.js";
import {
  sampleValidContractStub,
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
} from "../../integration/roles/fixtures.js";
import { createTestRepo, type TestRepo } from "../../integration/git/test-repo.js";

// R10.5: the ingest function is the one check a planner's plan and a resumed draft both pass through.
// These cases run it on a run directory the way a planning session leaves it.

let repo: TestRepo;
let runDir: string;

function writeDraft(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(runDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

function manifestWith(overrides: Record<string, unknown> = {}, tasks = [{ id: "T1", spec: "tasks/T1.md" }]): string {
  const base = sampleValidManifest(createRunId() as never);
  return YAML.stringify({ ...base, tasks, ...overrides });
}

function ingest() {
  return ingestPlanDraft({ runDir, repoRoot: repo.dir, settings: DEFAULT_SETTINGS });
}

beforeEach(() => {
  repo = createTestRepo("ingest-plan-");
  runDir = mkdtempSync(join(tmpdir(), "ingest-plan-run-"));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  repo.cleanup();
});

describe("R10.5: ingestPlanDraft accepts a complete draft exactly as the planner's own turn would", () => {
  it("a complete valid draft is accepted with its manifest and parsed specs", async () => {
    writeDraft({
      "manifest.yaml": manifestWith(),
      "tasks/T1.md": sampleValidTaskSpecMarkdown(),
      "contracts/types.ts": sampleValidContractStub(),
    });
    const res = await ingest();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.tasks.map((t) => t.id)).toEqual(["T1"]);
      expect(res.plan.specs.has("T1" as never)).toBe(true);
    }
  });

  it("a missing manifest is rejected with the planner's own diagnostic", async () => {
    const res = await ingest();
    expect(res).toMatchObject({ ok: false, diagnostics: ["manifest.yaml is missing from the run directory"] });
  });

  it("a task spec the manifest names but the draft does not hold is rejected", async () => {
    writeDraft({ "manifest.yaml": manifestWith(), "contracts/types.ts": sampleValidContractStub() });
    const res = await ingest();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.join("\n")).toContain("Spec file for task T1 does not exist: tasks/T1.md");
  });

  it("a spec missing a required heading is rejected", async () => {
    writeDraft({
      "manifest.yaml": manifestWith(),
      "tasks/T1.md": sampleValidTaskSpecMarkdown().replace("## Guardrails", "## Notes"),
      "contracts/types.ts": sampleValidContractStub(),
    });
    const res = await ingest();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.join("\n")).toContain("missing required heading: ## Guardrails");
  });

  it("a format lint error (a dependency on a task the plan does not have) is rejected", async () => {
    writeDraft({
      "manifest.yaml": manifestWith(),
      "tasks/T1.md": sampleValidTaskSpecMarkdown({ frontmatter: { depends_on: ["T9"] } }),
      "contracts/types.ts": sampleValidContractStub(),
    });
    const res = await ingest();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.length).toBeGreaterThan(0);
  });

  it("a contract typecheck error is rejected with the typecheck diagnostic", async () => {
    writeDraft({
      "manifest.yaml": manifestWith({
        contracts: { files: ["contracts/types.ts"], typecheck: [{ run: "node -e 'process.exit(1)'", timeout_s: 30 }] },
      }),
      "tasks/T1.md": sampleValidTaskSpecMarkdown(),
      "contracts/types.ts": sampleValidContractStub(),
    });
    const res = await ingest();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostics.join("\n")).toMatch(/L018|typecheck/);
  });

  it("an edited dependency that names an existing task is accepted (the edit takes effect)", async () => {
    writeDraft({
      "manifest.yaml": manifestWith({}, [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ]),
      "tasks/T1.md": sampleValidTaskSpecMarkdown(),
      "tasks/T2.md": sampleValidTaskSpecMarkdown({ frontmatter: { id: "T2", depends_on: ["T1"] } }),
      "contracts/types.ts": sampleValidContractStub(),
    });
    const res = await ingest();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const t2 = res.plan.specs.get("T2" as never);
      expect(t2?.frontmatter.depends_on).toEqual(["T1"]);
    }
  });
});
