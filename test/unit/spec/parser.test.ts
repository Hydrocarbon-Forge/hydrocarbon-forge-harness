import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import {
  parseManifest,
  parseTaskSpec,
} from "../../../src/spec/parser.js";
import {
  createTempRepo,
  sampleManifest,
  sampleManifestYaml,
  sampleTaskSpecMarkdown,
  SAMPLE_REQUIRED_SECTIONS,
} from "./fixtures.js";

describe("spec parser: parseManifest", () => {
  it("parses valid manifest YAML matching Manifest schema", () => {
    const yaml = sampleManifestYaml();
    const manifest = parseManifest(yaml, "manifest.yaml");

    expect(manifest.version).toBe(1);
    expect(manifest.run_id).toBe("r_234567ABCDEF");
    expect(manifest.goal).toBe("Test harness spec execution");
    expect(manifest.base_ref).toBe("main");
    expect(manifest.ecosystem).toBe("node-ts");
    expect(manifest.setup).toHaveLength(1);
    expect(manifest.contracts.files).toContain("src/contracts/index.ts");
    expect(manifest.contracts.typecheck).toHaveLength(1);
    expect(manifest.integration_verify).toHaveLength(1);
    expect(manifest.tasks).toHaveLength(2);
    expect(manifest.budget?.max_usd).toBe(2.0);
  });

  it("fails on empty manifest string or whitespace", () => {
    expect(() => parseManifest("", "manifest.yaml")).toThrow();
    expect(() => parseManifest("   \n\n  \t", "manifest.yaml")).toThrow();
  });

  it("fails on malformed YAML syntax", () => {
    const malformed = `
version: 1
run_id: [unclosed array
goal: "broken"
`;
    expect(() => parseManifest(malformed, "manifest.yaml")).toThrow();
  });

  it("fails on missing required schema fields", () => {
    // Missing goal
    const noGoal = sampleManifestYaml({ goal: undefined });
    expect(() => parseManifest(noGoal, "manifest.yaml")).toThrow();

    // Missing contracts
    const noContracts = sampleManifestYaml({ contracts: undefined });
    expect(() => parseManifest(noContracts, "manifest.yaml")).toThrow();

    // Missing tasks
    const noTasks = sampleManifestYaml({ tasks: undefined });
    expect(() => parseManifest(noTasks, "manifest.yaml")).toThrow();
  });

  it("fails on invalid RunId format", () => {
    const badRunId = sampleManifestYaml({ run_id: "invalid-run-id" });
    expect(() => parseManifest(badRunId, "manifest.yaml")).toThrow();
  });

  it("fails on unexpected extra fields due to strict schema", () => {
    const extraField = sampleManifestYaml({ unexpected_property: "disallowed" });
    expect(() => parseManifest(extraField, "manifest.yaml")).toThrow();
  });

  it("handles manifest with optional fields omitted", () => {
    const manifestObj = sampleManifest();
    delete (manifestObj as any).ecosystem;
    delete (manifestObj as any).budget;
    const yaml = YAML.stringify(manifestObj);
    const parsed = parseManifest(yaml);
    expect(parsed.ecosystem).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
    expect(parsed.version).toBe(1);
  });
});

describe("spec parser: parseTaskSpec", () => {
  it("parses valid task spec with frontmatter, sections, and code blocks", () => {
    const content = sampleTaskSpecMarkdown();
    const parsed = parseTaskSpec(content, "tasks/T1.md");

    expect(parsed.filePath).toBe("tasks/T1.md");
    expect(parsed.frontmatter.id).toBe("T1");
    expect(parsed.frontmatter.title).toBe("Task 1: Spec component");
    expect(parsed.frontmatter.class).toBe("feature");
    expect(parsed.frontmatter.verify).toHaveLength(1);
    expect(parsed.frontmatter.verify[0].run).toContain("npm test");

    // Sections extraction
    expect(parsed.sections).toBeInstanceOf(Map);
    for (const heading of Object.keys(SAMPLE_REQUIRED_SECTIONS)) {
      expect(parsed.sections.has(heading)).toBe(true);
      expect(parsed.sections.get(heading)?.length).toBeGreaterThan(0);
    }

    // Code blocks extraction
    expect(parsed.codeBlocks.length).toBeGreaterThan(0);
    const tsBlock = parsed.codeBlocks.find((cb) => cb.lang === "ts");
    expect(tsBlock).toBeDefined();
    expect(tsBlock?.code).toContain("export declare function sample()");
    expect(tsBlock?.lineStart).toBeGreaterThan(0);
    expect(tsBlock?.lineCount).toBeGreaterThan(0);
  });

  it("fails when frontmatter delimiters are missing or malformed", () => {
    const noStartFence = `
id: T1
title: No start fence
---
## Objective
Content
`;
    expect(() => parseTaskSpec(noStartFence)).toThrow();

    const noEndFence = `---
id: T1
title: No end fence
## Objective
Content
`;
    expect(() => parseTaskSpec(noEndFence)).toThrow();
  });

  it("fails when frontmatter fails TaskSpecFrontmatter schema", () => {
    // Missing id
    const missingId = sampleTaskSpecMarkdown({ frontmatter: { id: undefined } });
    expect(() => parseTaskSpec(missingId)).toThrow();

    // Invalid task id regex (starts with lowercase)
    const badId = sampleTaskSpecMarkdown({ frontmatter: { id: "invalidId" } });
    expect(() => parseTaskSpec(badId)).toThrow();

    // Empty verify command array
    const emptyVerify = sampleTaskSpecMarkdown({ frontmatter: { verify: [] } });
    expect(() => parseTaskSpec(emptyVerify)).toThrow();

    // Extra unknown field (strict schema)
    const extraField = sampleTaskSpecMarkdown({ frontmatter: { unknown_key: "forbidden" } });
    expect(() => parseTaskSpec(extraField)).toThrow();
  });

  it("extracts multiple code blocks with correct language, line start and line count", () => {
    const rawBody = `
## Objective
Implement features.

## Interface
\`\`\`ts
export interface Foo {
  bar: string;
}
\`\`\`

## Behavior
Step 1:
\`\`\`bash
npm run build
\`\`\`

## Invariants
Must hold.

## Edge cases
Empty.

## Guardrails
No unsafe paths.

## Out of scope
Remote services.
`;
    const spec = sampleTaskSpecMarkdown({ rawBody });
    const parsed = parseTaskSpec(spec, "tasks/T2.md");

    expect(parsed.codeBlocks).toHaveLength(2);
    expect(parsed.codeBlocks[0].lang).toBe("ts");
    expect(parsed.codeBlocks[0].code).toContain("export interface Foo");
    expect(parsed.codeBlocks[1].lang).toBe("bash");
    expect(parsed.codeBlocks[1].code).toContain("npm run build");
  });

  it("detects placeholder tokens outside code fences in Interface or Behavior", () => {
    const placeholders = ["TODO", "FIXME", "TBD", "...", "<placeholder>"];

    for (const token of placeholders) {
      const specWithPlaceholder = sampleTaskSpecMarkdown({
        sections: {
          Behavior: `This is a work in progress with ${token} token here.`,
        },
      });
      // Should throw or flag L013 diagnostic
      expect(() => parseTaskSpec(specWithPlaceholder)).toThrow();
    }
  });

  it("ignores placeholder-like runs inside inline code spans in Interface", () => {
    const specWithInlineCode = sampleTaskSpecMarkdown({
      sections: {
        Interface: `Construct the client with \`new Client({ ...opts })\` and pass the options through.`,
      },
    });
    const parsed = parseTaskSpec(specWithInlineCode);
    expect(parsed.frontmatter.id).toBe("T1");
  });

  it("still throws for a bare TODO marker outside code spans in Interface", () => {
    const specWithBareTodo = sampleTaskSpecMarkdown({
      sections: {
        Interface: "The return type is still open, so TODO decide it before the run.",
      },
    });
    expect(() => parseTaskSpec(specWithBareTodo)).toThrow(/Placeholder token detected/);
  });

  it("allows placeholder tokens when enclosed inside code fences", () => {
    const specWithCodePlaceholder = sampleTaskSpecMarkdown({
      sections: {
        Interface: `\`\`\`ts\n// TODO: type signature\nexport type Sample = string;\n\`\`\``,
        Behavior: `\`\`\`bash\n# FIXME: placeholder script\necho "test"\n\`\`\``,
      },
    });
    // Inside code fences, tokens like TODO / FIXME are permitted
    const parsed = parseTaskSpec(specWithCodePlaceholder);
    expect(parsed.frontmatter.id).toBe("T1");
  });

  it("normalizes Windows CRLF (\\r\\n) line endings transparently", () => {
    const content = sampleTaskSpecMarkdown();
    const crlfContent = content.replace(/\n/g, "\r\n");

    const parsed = parseTaskSpec(crlfContent, "tasks/T1.md");
    expect(parsed.frontmatter.id).toBe("T1");
    expect(parsed.sections.get("Objective")).not.toContain("\r");
    // Line counts and start lines remain valid
    expect(parsed.codeBlocks[0].lineStart).toBeGreaterThan(0);
  });

  it("handles frontmatter delimiters '---' inside code blocks in markdown body", () => {
    const bodyWithFences = `
## Objective
Parse YAML configs.

## Interface
\`\`\`yaml
---
sample: true
---
\`\`\`

## Behavior
Processes config.

## Invariants
Safe.

## Edge cases
Handles nested fences.

## Guardrails
Protected.

## Out of scope
Nothing.
`;
    const content = sampleTaskSpecMarkdown({ rawBody: bodyWithFences });
    const parsed = parseTaskSpec(content, "tasks/T1.md");
    expect(parsed.frontmatter.id).toBe("T1");
    expect(parsed.sections.get("Interface")).toContain("sample: true");
  });

  it("preserves unicode characters in title and section content", () => {
    const unicodeContent = sampleTaskSpecMarkdown({
      frontmatter: { title: "Task ⚡: Unicode handling — 🚀" },
      sections: {
        Objective: "Objective with special symbols: §15, «guillemets», and 🎯.",
      },
    });
    const parsed = parseTaskSpec(unicodeContent);
    expect(parsed.frontmatter.title).toContain("⚡");
    expect(parsed.sections.get("Objective")).toContain("§15");
    expect(parsed.sections.get("Objective")).toContain("🎯");
  });
});

describe("spec parser: manifest and linked task specs from disk", () => {
  it("parseManifest and parseTaskSpec load the manifest and all linked task specs from disk", () => {
    const repo = createTempRepo();
    const manifestPath = join(repo, "manifest.yaml");

    const t1Path = join(repo, "tasks", "T1.md");
    const t2Path = join(repo, "tasks", "T2.md");

    const manifestYaml = sampleManifestYaml({
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
    });
    writeFileSync(manifestPath, manifestYaml, "utf8");

    writeFileSync(t1Path, sampleTaskSpecMarkdown({ frontmatter: { id: "T1" } }), "utf8");
    writeFileSync(t2Path, sampleTaskSpecMarkdown({ frontmatter: { id: "T2" } }), "utf8");

    const manifest = parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    const specs = new Map(
      manifest.tasks.map((task) => [
        task.id,
        parseTaskSpec(readFileSync(join(repo, task.spec), "utf8"), task.spec),
      ]),
    );

    expect(manifest.run_id).toBe("r_234567ABCDEF");
    expect(specs.size).toBe(2);
    expect(specs.get("T1")?.frontmatter.id).toBe("T1");
    expect(specs.get("T2")?.frontmatter.id).toBe("T2");
  });
});
