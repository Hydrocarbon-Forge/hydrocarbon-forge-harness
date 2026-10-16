import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

import type {
  Manifest,
  TaskSpecFrontmatter,
  TaskId,
  Command,
  Diagnostic,
  Settings,
  VerifyResult,
} from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import type {
  ParsedTaskSpec,
  ParsedPlan,
  CodeBlock,
} from "../../../src/spec/index.js";

export function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-spec-test-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".substrate"), { recursive: true });
  mkdirSync(join(dir, "tasks"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  return dir;
}

export function sampleCommand(run = "echo ok", timeout_s = 30): Command {
  return { run, timeout_s };
}

export function sampleManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    run_id: "r_234567ABCDEF",
    goal: "Test harness spec execution",
    base_ref: "main",
    ecosystem: "node-ts",
    setup: [{ run: "npm install", timeout_s: 60 }],
    contracts: {
      files: ["src/contracts/index.ts"],
      typecheck: [{ run: "npm run typecheck", timeout_s: 60 }],
    },
    integration_verify: [{ run: "npm test", timeout_s: 120 }],
    tasks: [
      { id: "T1", spec: "tasks/T1.md" },
      { id: "T2", spec: "tasks/T2.md" },
    ],
    budget: {
      max_usd: 2.0,
      max_tokens: 100000,
      max_wall_min: 30,
    },
    ...overrides,
  };
}

export function sampleManifestYaml(overrides: Record<string, unknown> = {}): string {
  const manifest = sampleManifest();
  const merged = { ...manifest, ...overrides };
  return YAML.stringify(merged);
}

export function sampleTaskSpecFrontmatter(overrides: Partial<TaskSpecFrontmatter> = {}): TaskSpecFrontmatter {
  return {
    id: "T1",
    title: "Task 1: Spec component",
    class: "feature",
    depends_on: [],
    read: ["src/contracts/index.ts"],
    write: [],
    create: ["src/feature/index.ts"],
    protected: ["src/contracts/index.ts"],
    verify: [{ run: "npm test -- test/unit/feature", timeout_s: 60 }],
    effort: "medium",
    budget: {
      max_usd: 0.25,
      max_tokens: 25000,
      timeout_min: 15,
      max_turns: 10,
    },
    ...overrides,
  };
}

export const SAMPLE_REQUIRED_SECTIONS: Record<string, string> = {
  Objective: "Implement feature component satisfying requirements.",
  Interface: "```ts\nexport declare function sample(): void;\n```",
  Behavior: "Executes sample functionality deterministically.",
  Invariants: "Maintains isolation and immutability.",
  "Edge cases": "Handles empty inputs and unexpected types gracefully.",
  Guardrails: "Never mutates state outside of approved paths.",
  "Out of scope": "Performance optimizations and remote telemetry.",
};

export function sampleTaskSpecMarkdown(options: {
  frontmatter?: Record<string, unknown>;
  sections?: Record<string, string>;
  rawBody?: string;
} = {}): string {
  const fm = {
    ...sampleTaskSpecFrontmatter(),
    ...(options.frontmatter ?? {}),
  };
  const fmLines = YAML.stringify(fm).trim();

  let body = "";
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else {
    const sections = { ...SAMPLE_REQUIRED_SECTIONS, ...(options.sections ?? {}) };
    body = Object.entries(sections)
      .map(([title, content]) => `## ${title}\n\n${content}`)
      .join("\n\n");
  }

  return `---\n${fmLines}\n---\n\n${body}\n`;
}

export function sampleParsedTaskSpec(overrides: Partial<ParsedTaskSpec> = {}): ParsedTaskSpec {
  const frontmatter = sampleTaskSpecFrontmatter(overrides.frontmatter);
  const sections = new Map<string, string>(Object.entries(SAMPLE_REQUIRED_SECTIONS));
  const codeBlocks: CodeBlock[] = [
    {
      lang: "ts",
      code: "export declare function sample(): void;",
      lineStart: 10,
      lineCount: 1,
    },
  ];

  return {
    frontmatter,
    rawFrontmatter: YAML.stringify(frontmatter),
    body: Object.entries(SAMPLE_REQUIRED_SECTIONS)
      .map(([title, content]) => `## ${title}\n\n${content}`)
      .join("\n\n"),
    sections,
    codeBlocks,
    filePath: "tasks/T1.md",
    ...overrides,
  };
}

export function sampleParsedPlan(options: {
  manifest?: Partial<Manifest>;
  specs?: ParsedTaskSpec[];
  manifestPath?: string;
} = {}): ParsedPlan {
  const manifest = sampleManifest(options.manifest);
  const specsMap = new Map<TaskId, ParsedTaskSpec>();

  if (options.specs) {
    for (const spec of options.specs) {
      specsMap.set(spec.frontmatter.id, spec);
    }
  } else {
    for (const task of manifest.tasks) {
      const spec = sampleParsedTaskSpec({
        frontmatter: sampleTaskSpecFrontmatter({ id: task.id }),
        filePath: task.spec,
      });
      specsMap.set(task.id, spec);
    }
  }

  return {
    manifest,
    specs: specsMap,
    rawManifest: YAML.stringify(manifest),
    manifestPath: options.manifestPath ?? "manifest.yaml",
  };
}

export function sampleSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}
