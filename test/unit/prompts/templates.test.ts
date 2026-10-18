import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { loadTemplate, listAgents } from "../../../src/prompts/index.js";
import { render } from "../../../src/prompts/render.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Copied from assets/prompts/README.md, the "Variables" table.
const TABLE: Record<string, string[]> = {
  "planner/request.md": [
    "request", "run_id", "base_ref", "repo_root", "classes", "task_budget",
    "run_budget", "max_tasks", "charter", "history", "instruction_files",
    "skills", "repo_map",
  ],
  "planner/correction.md": ["attempt", "max_attempts", "diagnostics"],
  "planner/replan-l1.md": [
    "task_id", "generation", "failure_class", "spec_path", "failure_details",
    "diff_summary", "worker_summary", "task_spec", "related_contracts",
    "dependents", "decisions",
  ],
  "planner/replan-l2.md": [
    "task_id", "failure_class", "escalation_reason", "failure_details",
    "worker_summary", "manifest", "task_states", "contracts", "decisions",
  ],
  "worker/task.md": ["spec_path"],
  "test-writer/task.md": ["spec_path"],
  "worker/heal.md": ["failures"],
  "reviewer/review.md": ["task_specs", "contracts", "diff"],
};

function walkMarkdown(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

function placeholderNames(content: string): string[] {
  return [...new Set(content.match(/\{\{([a-z_]+)\}\}/g) ?? [])].map((m) => m.slice(2, -2));
}

function makeTempDir(prefix: string): string {
  const base = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();
  return mkdtempSync(join(base, prefix));
}

describe("templates under assets/prompts (all rendered with README-table variables)", () => {
  const templateFiles = walkMarkdown(join(REPO_ROOT, "assets", "prompts")).filter(
    (f) => !f.endsWith("README.md"),
  );

  it("finds every template file", () => {
    expect(templateFiles.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of templateFiles) {
    const rel = file.slice(REPO_ROOT.length + 1).split("assets/prompts/")[1];
    const content = readFileSync(file, "utf8");
    const names = placeholderNames(content);
    const vars: Record<string, string> = Object.fromEntries(
      (TABLE[rel] ?? []).map((n) => [n, `sample-${n}`]),
    );

    it(`matches the README table for ${rel}`, () => {
      const expected = new Set(TABLE[rel] ?? []);
      const actual = new Set(names);
      expect([...actual].sort()).toEqual([...expected].sort());
    });

    it(`renders with sample variables for ${rel}`, () => {
      const out = render(content, vars);
      expect(out).not.toContain("{{");
      if (expectedHasValue(rel)) {
        expect(out).toContain(`sample-${(TABLE[rel] ?? [])[0]}`);
      }
    });
  }
});

// Every template in the table has at least one variable, so a sample
// value must survive in the rendered output.
function expectedHasValue(rel: string): boolean {
  return (TABLE[rel] ?? []).length > 0;
}

describe("override resolution", () => {
  const tmp = makeTempDir("substrate-tpl-test-");
  const userDir = makeTempDir("substrate-tpl-user-");

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("a project override template with an unknown variable fails render", () => {
    const dir = join(tmp, ".substrate", "prompts", "worker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task.md"), "{{unknown_var}}\n");

    const template = loadTemplate("worker/task.md", { projectRoot: tmp, userConfigDir: userDir });
    expect(template).toBe("{{unknown_var}}\n");
    expect(() => render(template, { spec_path: "x" })).toThrow(
      "missing template variable: unknown_var",
    );
  });

  it("a project override agent file is reported with its source and path", () => {
    const dir = join(tmp, ".substrate", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "worker.md"),
      "---\nname: worker\ndescription: Project worker override\n---\nProject worker body.\n",
    );

    const agents = listAgents({ projectRoot: tmp, userConfigDir: userDir });
    const roles = agents.map((a) => a.role);
    expect(roles).toEqual(["planner", "worker", "test-writer", "reviewer", "governor"]);

    const worker = agents.find((a) => a.role === "worker");
    expect(worker?.source).toBe("project");
    expect(worker?.path).toContain(tmp);
    expect(worker?.path).toContain(join(".substrate", "agents", "worker.md"));

    const others = agents.filter((a) => a.role !== "worker");
    for (const a of others) {
      expect(a.source).toBe("built-in");
    }
  });
});
