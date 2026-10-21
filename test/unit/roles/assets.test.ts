import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import * as Contracts from "../../../src/contracts/index.js";
import { listAgents } from "../../../src/prompts/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const ASSETS_DIR = resolve(REPO_ROOT, "assets/agents");

function parseAgentMarkdown(filePath: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`File at ${filePath} has missing or malformed frontmatter`);
  }
  const frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
  return { frontmatter, body: match[2].trim() };
}

describe("Role Assets (assets/agents/*.md)", () => {
  const EXPECTED_AGENTS = [
    "planner",
    "worker",
    "test-writer",
    "reviewer",
  ] as const;

  describe("File existence and discovery", () => {
    it.each(EXPECTED_AGENTS)(
      "discovers built-in agent definition for %s.md",
      (agentName) => {
        const filePath = resolve(ASSETS_DIR, `${agentName}.md`);
        expect(existsSync(filePath)).toBe(true);
      },
    );

    it("lists all 4 built-in agent roles from assets/agents via listAgents", () => {
      const empty = mkdtempSync(join(tmpdir(), "substrate-assets-"));
      const res = listAgents({ projectRoot: empty, userConfigDir: empty });

      expect(res.every((a) => a.source === "built-in")).toBe(true);
      expect(res.map((a) => a.role).sort()).toEqual([...EXPECTED_AGENTS].sort());
    });
  });

  describe("Worker Agent Asset (assets/agents/worker.md)", () => {
    it("declares role 'worker' and valid frontmatter matching RoleName schema", () => {
      const filePath = resolve(ASSETS_DIR, "worker.md");
      const { frontmatter } = parseAgentMarkdown(filePath);

      expect(frontmatter.name).toBe("worker");
      expect(frontmatter.role).toBe("worker");
      expect(typeof frontmatter.description).toBe("string");
      expect((frontmatter.description as string).length).toBeGreaterThan(0);
      expect(Contracts.RoleName.safeParse(frontmatter.role).success).toBe(true);
    });

    it("sets omitClaudeMd: true in frontmatter to suppress Claude Code markdown bloat", () => {
      const filePath = resolve(ASSETS_DIR, "worker.md");
      const { frontmatter } = parseAgentMarkdown(filePath);

      expect(frontmatter.omitClaudeMd).toBe(true);
    });

    it("restricts tools: disallows git commit, push, checkout, reset, rebase, clean, and subagents", () => {
      const filePath = resolve(ASSETS_DIR, "worker.md");
      const { frontmatter } = parseAgentMarkdown(filePath);

      const disallowed = (frontmatter.disallowedTools as string[]) || [];
      expect(disallowed).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/git\s+(commit|push|checkout|reset|rebase|clean)/i),
        ]),
      );
    });

    it("instructs unattended execution, strict task-spec focus, and one-line DONE/BLOCKED reply", () => {
      const filePath = resolve(ASSETS_DIR, "worker.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toMatch(/task spec/i);
      expect(body).toMatch(/DONE|BLOCKED/);
      expect(body).toMatch(/do not run git commit/i);
    });
  });

  describe("Planner Agent Asset (assets/agents/planner.md)", () => {
    it("declares role 'planner' and valid frontmatter matching RoleName schema", () => {
      const filePath = resolve(ASSETS_DIR, "planner.md");
      const { frontmatter } = parseAgentMarkdown(filePath);

      expect(frontmatter.name).toBe("planner");
      expect(frontmatter.role).toBe("planner");
      expect(Contracts.RoleName.safeParse(frontmatter.role).success).toBe(true);
    });

    it("body strictly directs authoring manifest.yaml, task specs, and contract stubs into run directory", () => {
      const filePath = resolve(ASSETS_DIR, "planner.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toMatch(/manifest\.yaml/i);
      expect(body).toMatch(/contract/i);
      expect(body).toMatch(/task specs?/i);
    });

    it("strictly forbids planner from creating implementation bodies in stubs or specs", () => {
      const filePath = resolve(ASSETS_DIR, "planner.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toMatch(/forbid(den)?.*implementation/i);
    });

    it("states when tests earn their place, with the tests-class target convention", () => {
      const filePath = resolve(ASSETS_DIR, "planner.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toContain("## When tests earn their place");
      expect(body).toContain("test targets");
    });
  });

  describe("Test-Writer Agent Asset (assets/agents/test-writer.md)", () => {
    it("declares role 'test-writer' and valid frontmatter matching RoleName schema", () => {
      const filePath = resolve(ASSETS_DIR, "test-writer.md");
      const { frontmatter } = parseAgentMarkdown(filePath);

      expect(frontmatter.name).toBe("test-writer");
      expect(frontmatter.role).toBe("test-writer");
      expect(Contracts.RoleName.safeParse(frontmatter.role).success).toBe(true);
    });

    it("body directs authoring test files satisfying contracts and acceptance criteria before implementation", () => {
      const filePath = resolve(ASSETS_DIR, "test-writer.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toMatch(/test/i);
      expect(body).toMatch(/contract/i);
      expect(body).toMatch(/acceptance criteria|verify/i);
    });

    it("forbids test-writer from modifying application source code", () => {
      const filePath = resolve(ASSETS_DIR, "test-writer.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toMatch(/forbid|never modify.*application|source code/i);
    });

    it("limits tests to the spec's listed targets and no longer requires a test per listed item", () => {
      const filePath = resolve(ASSETS_DIR, "test-writer.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toContain("Test exactly the targets the spec lists");
      expect(body).not.toContain("each listed edge case gets at least one test");
    });
  });

  describe("Reviewer Agent Asset (assets/agents/reviewer.md)", () => {
    it("declares role 'reviewer' and valid frontmatter matching RoleName schema", () => {
      const filePath = resolve(ASSETS_DIR, "reviewer.md");
      const { frontmatter } = parseAgentMarkdown(filePath);

      expect(frontmatter.name).toBe("reviewer");
      expect(frontmatter.role).toBe("reviewer");
      expect(Contracts.RoleName.safeParse(frontmatter.role).success).toBe(true);
    });

    it("body instructs evaluating final patch diff against contracts, scope isolation, and invariants", () => {
      const filePath = resolve(ASSETS_DIR, "reviewer.md");
      const { body } = parseAgentMarkdown(filePath);

      expect(body).toMatch(/diff|patch/i);
      expect(body).toMatch(/contract/i);
      expect(body).toMatch(/scope|invariant/i);
    });
  });
});
