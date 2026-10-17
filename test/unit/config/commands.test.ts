import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type * as Contracts from "../../../src/contracts/index.js";
import { parseJsonc } from "../../../src/config/index.js";

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  model?: string;
  body: string;
  path: string;
  source: "project" | "user" | "builtin";
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source: "project" | "user" | "builtin";
}

export interface SkillDefinition extends SkillSummary {
  body: string;
}

export interface AgentsImportOptions {
  from: "claude" | "opencode";
  sourceDir?: string;
  targetDir?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  cwd?: string;
}

export interface ImportReport {
  imported: string[];
  skipped: string[];
  errors: string[];
}

async function loadCommandsModule(): Promise<{
  loadCommandDefinitions: (opts?: {
    projectDir?: string;
    userDir?: string;
    builtinDir?: string;
  }) => Promise<{ commands: CommandDefinition[]; errors: Error[] }>;
  resolveCommand: (
    name: string,
    projectDir?: string,
    opts?: { userDir?: string; builtinDir?: string }
  ) => Promise<CommandDefinition | null>;
  expandCommandTemplate: (body: string, args: string) => string;
}> {
  return (await import("../../../src/config/commands.js" as any)) as any;
}

async function loadSkillsModule(): Promise<{
  loadSkillSummaries: (opts?: {
    projectDir?: string;
    userDir?: string;
    builtinDir?: string;
  }) => Promise<{ skills: SkillSummary[]; errors: Error[] }>;
  formatSkillsForPlanner: (skills: SkillSummary[]) => string;
  readSkillBody: (skillPath: string) => Promise<string>;
}> {
  return (await import("../../../src/config/skills.js" as any)) as any;
}

async function loadAgentsImportModule(): Promise<{
  runAgentsImport: (opts: AgentsImportOptions) => Promise<ImportReport>;
}> {
  return (await import("../../../src/cli/agents-import.js" as any)) as any;
}

describe("commands, skills & foreign agents import", () => {
  let tmpDir: string;
  let projectDir: string;
  let userDir: string;
  let builtinDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-cfg-cmd-test-"));
    projectDir = join(tmpDir, "project");
    userDir = join(tmpDir, "user");
    builtinDir = join(tmpDir, "builtin");

    mkdirSync(join(projectDir, ".substrate", "commands"), { recursive: true });
    mkdirSync(join(userDir, "commands"), { recursive: true });
    mkdirSync(join(builtinDir, "commands"), { recursive: true });

    mkdirSync(join(projectDir, ".substrate", "skills"), { recursive: true });
    mkdirSync(join(userDir, "skills"), { recursive: true });
    mkdirSync(join(builtinDir, "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================
  // COMMANDS DISCOVERY & PRECEDENCE
  // ==========================================
  describe("commands discovery and hierarchical precedence", () => {
    it("discovers commands in project, user, and builtin directories", async () => {
      const { loadCommandDefinitions } = await loadCommandsModule();

      writeFileSync(
        join(projectDir, ".substrate", "commands", "review.md"),
        `---
description: "Review pull request"
argument-hint: "[pr-number]"
model: "claude-3-7-sonnet"
---
Review code changes for $ARGUMENTS thoroughly.`
      );

      writeFileSync(
        join(userDir, "commands", "format.md"),
        `---
description: "Format repository"
---
Run prettier on all files.`
      );

      writeFileSync(
        join(builtinDir, "commands", "help.md"),
        `---
description: "Display help text"
---
Display usage help for Substrate.`
      );

      const { commands, errors } = await loadCommandDefinitions({
        projectDir,
        userDir,
        builtinDir,
      });

      expect(errors).toEqual([]);
      expect(commands).toHaveLength(3);

      const review = commands.find((c) => c.name === "review");
      expect(review).toBeDefined();
      expect(review?.source).toBe("project");
      expect(review?.description).toBe("Review pull request");
      expect(review?.argumentHint).toBe("[pr-number]");
      expect(review?.model).toBe("claude-3-7-sonnet");
      expect(review?.body.trim()).toBe("Review code changes for $ARGUMENTS thoroughly.");

      const format = commands.find((c) => c.name === "format");
      expect(format?.source).toBe("user");

      const help = commands.find((c) => c.name === "help");
      expect(help?.source).toBe("builtin");
    });

    it("enforces precedence: project shadows user and builtin definitions with the same name", async () => {
      const { loadCommandDefinitions } = await loadCommandsModule();

      // Project definition
      writeFileSync(
        join(projectDir, ".substrate", "commands", "deploy.md"),
        `---
description: "Project deploy command"
---
Deploy to staging.`
      );

      // User definition
      writeFileSync(
        join(userDir, "commands", "deploy.md"),
        `---
description: "User deploy command"
---
Deploy to personal server.`
      );

      // Builtin definition
      writeFileSync(
        join(builtinDir, "commands", "deploy.md"),
        `---
description: "Builtin deploy command"
---
Deploy default target.`
      );

      const { commands } = await loadCommandDefinitions({
        projectDir,
        userDir,
        builtinDir,
      });

      const deployCommands = commands.filter((c) => c.name === "deploy");
      expect(deployCommands).toHaveLength(1);
      expect(deployCommands[0].source).toBe("project");
      expect(deployCommands[0].description).toBe("Project deploy command");
      expect(deployCommands[0].body.trim()).toBe("Deploy to staging.");
    });

    it("enforces precedence: user shadows builtin definitions with the same name", async () => {
      const { loadCommandDefinitions } = await loadCommandsModule();

      writeFileSync(
        join(userDir, "commands", "lint.md"),
        `---
description: "User lint"
---
Run custom linter.`
      );

      writeFileSync(
        join(builtinDir, "commands", "lint.md"),
        `---
description: "Builtin lint"
---
Run default eslint.`
      );

      const { commands } = await loadCommandDefinitions({
        projectDir,
        userDir,
        builtinDir,
      });

      const lintCommands = commands.filter((c) => c.name === "lint");
      expect(lintCommands).toHaveLength(1);
      expect(lintCommands[0].source).toBe("user");
      expect(lintCommands[0].description).toBe("User lint");
    });

    it("handles malformed YAML frontmatter by recording error and continuing with valid commands", async () => {
      const { loadCommandDefinitions } = await loadCommandsModule();

      // Malformed file
      writeFileSync(
        join(projectDir, ".substrate", "commands", "bad.md"),
        `---
description: [unclosed yaml list
---
Broken template`
      );

      // Valid sibling file
      writeFileSync(
        join(projectDir, ".substrate", "commands", "good.md"),
        `---
description: "Valid command"
---
Good template`
      );

      const { commands, errors } = await loadCommandDefinitions({
        projectDir,
        userDir,
        builtinDir,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(commands.some((c) => c.name === "good")).toBe(true);
      expect(commands.some((c) => c.name === "bad")).toBe(false);
    });

    it("resolves command by name following precedence", async () => {
      const { resolveCommand } = await loadCommandsModule();

      writeFileSync(
        join(projectDir, ".substrate", "commands", "test.md"),
        `---
description: "Run tests"
---
npm test -- $ARGUMENTS`
      );

      const cmd = await resolveCommand("test", projectDir, { userDir, builtinDir });
      expect(cmd).not.toBeNull();
      expect(cmd?.name).toBe("test");
      expect(cmd?.source).toBe("project");

      const notFound = await resolveCommand("nonexistent", projectDir, { userDir, builtinDir });
      expect(notFound).toBeNull();
    });
  });

  // ==========================================
  // $ARGUMENTS TEMPLATE EXPANSION
  // ==========================================
  describe("command template expansion ($ARGUMENTS)", () => {
    it("replaces all occurrences of $ARGUMENTS with argument text", async () => {
      const { expandCommandTemplate } = await loadCommandsModule();

      const body = "Verify $ARGUMENTS, then run benchmark on $ARGUMENTS.";
      const expanded = expandCommandTemplate(body, "src/index.ts");

      expect(expanded).toBe("Verify src/index.ts, then run benchmark on src/index.ts.");
    });

    it("replaces $ARGUMENTS with empty string when no arguments provided and trims whitespace", async () => {
      const { expandCommandTemplate } = await loadCommandsModule();

      const body = "Run test suite: $ARGUMENTS.";
      const expanded = expandCommandTemplate(body, "");

      expect(expanded).toBe("Run test suite:.");
    });

    it("appends arguments separated by space when template body does not contain $ARGUMENTS", async () => {
      const { expandCommandTemplate } = await loadCommandsModule();

      const body = "Please inspect the codebase";
      const expanded = expandCommandTemplate(body, "for security issues");

      expect(expanded).toBe("Please inspect the codebase for security issues");
    });

    it("leaves template body untouched when no $ARGUMENTS token and no arguments provided", async () => {
      const { expandCommandTemplate } = await loadCommandsModule();

      const body = "Perform a clean build";
      const expanded = expandCommandTemplate(body, "");

      expect(expanded).toBe("Perform a clean build");
    });

    it("pure substitution: preserves surrounding code blocks and punctuation", async () => {
      const { expandCommandTemplate } = await loadCommandsModule();

      const body = "```bash\ngit checkout -b feature/$ARGUMENTS\n```";
      const expanded = expandCommandTemplate(body, "login-page");

      expect(expanded).toBe("```bash\ngit checkout -b feature/login-page\n```");
    });
  });

  // ==========================================
  // SKILLS SEMANTICS & PROGRESSIVE DISCLOSURE
  // ==========================================
  describe("skills semantics and progressive disclosure", () => {
    it("discovers skills in <name>/SKILL.md directory structure and <name>.md flat files", async () => {
      const { loadSkillSummaries } = await loadSkillsModule();

      // Directory structure
      const skillDir = join(projectDir, ".substrate", "skills", "git-master");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---
name: "git-master"
description: "Expert git history manipulation and bisecting"
---
# Git Master Skill
Full body instructions for git.`
      );

      // Flat file structure
      writeFileSync(
        join(userDir, "skills", "docker-helper.md"),
        `---
name: "docker-helper"
description: "Containerization helper"
---
# Docker Helper Skill
Full docker instructions.`
      );

      const { skills, errors } = await loadSkillSummaries({
        projectDir,
        userDir,
        builtinDir,
      });

      expect(errors).toEqual([]);
      expect(skills.length).toBeGreaterThanOrEqual(2);

      const gitSkill = skills.find((s) => s.name === "git-master");
      expect(gitSkill).toBeDefined();
      expect(gitSkill?.description).toBe("Expert git history manipulation and bisecting");
      expect(gitSkill?.source).toBe("project");

      const dockerSkill = skills.find((s) => s.name === "docker-helper");
      expect(dockerSkill).toBeDefined();
      expect(dockerSkill?.source).toBe("user");
    });

    it("enforces skill precedence: project shadows user, user shadows builtin", async () => {
      const { loadSkillSummaries } = await loadSkillsModule();

      const projectSkill = join(projectDir, ".substrate", "skills", "refactor");
      mkdirSync(projectSkill, { recursive: true });
      writeFileSync(
        join(projectSkill, "SKILL.md"),
        `---
description: "Project refactor skill"
---
Refactor project code.`
      );

      const userSkill = join(userDir, "skills", "refactor");
      mkdirSync(userSkill, { recursive: true });
      writeFileSync(
        join(userSkill, "SKILL.md"),
        `---
description: "User refactor skill"
---
Refactor user code.`
      );

      const { skills } = await loadSkillSummaries({
        projectDir,
        userDir,
        builtinDir,
      });

      const refactorSkills = skills.filter((s) => s.name === "refactor");
      expect(refactorSkills).toHaveLength(1);
      expect(refactorSkills[0].source).toBe("project");
      expect(refactorSkills[0].description).toBe("Project refactor skill");
    });

    it("skips directories without SKILL.md with a diagnostic warning without crashing", async () => {
      const { loadSkillSummaries } = await loadSkillsModule();

      const emptySkillDir = join(projectDir, ".substrate", "skills", "not-a-skill");
      mkdirSync(emptySkillDir, { recursive: true });
      writeFileSync(join(emptySkillDir, "README.txt"), "Not a skill");

      const validSkillDir = join(projectDir, ".substrate", "skills", "valid-skill");
      mkdirSync(validSkillDir, { recursive: true });
      writeFileSync(
        join(validSkillDir, "SKILL.md"),
        `---
description: "Valid skill"
---
Valid skill body.`
      );

      const { skills } = await loadSkillSummaries({
        projectDir,
        userDir,
        builtinDir,
      });

      expect(skills.some((s) => s.name === "valid-skill")).toBe(true);
      expect(skills.some((s) => s.name === "not-a-skill")).toBe(false);
    });

    it("progressive disclosure: formats ONLY name and description catalog for Planner prompt without body", async () => {
      const { formatSkillsForPlanner } = await loadSkillsModule();

      const sampleSkills: SkillSummary[] = [
        {
          name: "sql-optimizer",
          description: "Optimizes slow SQL queries and indexes",
          path: "/workspace/.substrate/skills/sql-optimizer/SKILL.md",
          source: "project",
        },
        {
          name: "test-generator",
          description: "Generates Vitest test suites",
          path: "/workspace/assets/skills/test-generator.md",
          source: "builtin",
        },
      ];

      const formatted = formatSkillsForPlanner(sampleSkills);

      expect(formatted).toContain("- sql-optimizer: Optimizes slow SQL queries and indexes (path: /workspace/.substrate/skills/sql-optimizer/SKILL.md)");
      expect(formatted).toContain("- test-generator: Generates Vitest test suites (path: /workspace/assets/skills/test-generator.md)");

      // Invariant: Full body is never present in planner prompt catalog
      expect(formatted).not.toContain("Full body");
      expect(formatted).not.toContain("Optimizes slow SQL queries and indexes\n#");
    });

    it("loads full skill body on demand via readSkillBody", async () => {
      const { readSkillBody } = await loadSkillsModule();

      const skillFilePath = join(tmpDir, "SKILL.md");
      writeFileSync(
        skillFilePath,
        `---
name: "demo"
description: "Demo"
---
# Demo Skill Content
This is the detailed markdown instructions loaded on demand.`
      );

      const body = await readSkillBody(skillFilePath);
      expect(body).toContain("# Demo Skill Content");
      expect(body).toContain("This is the detailed markdown instructions loaded on demand.");
    });
  });

  // ==========================================
  // AGENTS IMPORT SUBCOMMAND
  // ==========================================
  describe("agents import: foreign conversion and isolation invariant", () => {
    it("invariant: foreign directories (.claude/, .opencode/) are NEVER read implicitly", async () => {
      const { loadCommandDefinitions } = await loadCommandsModule();
      const { loadSkillSummaries } = await loadSkillsModule();

      // Put files in foreign directories inside project
      const foreignClaude = join(projectDir, ".claude", "agents");
      const foreignOpenCode = join(projectDir, ".opencode", "agents");
      mkdirSync(foreignClaude, { recursive: true });
      mkdirSync(foreignOpenCode, { recursive: true });

      writeFileSync(join(foreignClaude, "stealth.md"), "---\nname: stealth\n---\nPrompt");
      writeFileSync(join(foreignOpenCode, "hidden.json"), JSON.stringify({ name: "hidden" }));

      const { commands } = await loadCommandDefinitions({ projectDir });
      const { skills } = await loadSkillSummaries({ projectDir });

      // Invariant: Neither commands nor skills discovery implicitly ingests foreign agents
      expect(commands.some((c) => c.name === "stealth" || c.name === "hidden")).toBe(false);
      expect(skills.some((s) => s.name === "stealth" || s.name === "hidden")).toBe(false);
    });

    it("converts foreign Claude agent definitions to .substrate/agents/*.md", async () => {
      const { runAgentsImport } = await loadAgentsImportModule();

      const sourceDir = join(tmpDir, "foreign-claude");
      const targetDir = join(projectDir, ".substrate", "agents");
      mkdirSync(sourceDir, { recursive: true });

      writeFileSync(
        join(sourceDir, "code-reviewer.md"),
        `---
name: code-reviewer
description: "Automated PR reviewer"
tools:
  - Bash
  - ReadFile
disallowedTools:
  - WriteFile
model: claude-3-7-sonnet
role: reviewer
permissionMode: default
---
You are an expert code reviewer specializing in performance and security.`
      );

      const report = await runAgentsImport({
        from: "claude",
        sourceDir,
        targetDir,
        cwd: projectDir,
      });

      expect(report.errors).toEqual([]);
      expect(report.imported).toContain("code-reviewer");

      const convertedFile = join(targetDir, "code-reviewer.md");
      expect(existsSync(convertedFile)).toBe(true);

      const content = readFileSync(convertedFile, "utf8");
      expect(content).toContain("name: code-reviewer");
      expect(content).toContain("role: reviewer");
      expect(content).toContain("You are an expert code reviewer specializing in performance and security.");
    });

    it("defaults invalid or unspecified role in foreign definition to 'worker'", async () => {
      const { runAgentsImport } = await loadAgentsImportModule();

      const sourceDir = join(tmpDir, "claude-unknown-role");
      const targetDir = join(projectDir, ".substrate", "agents");
      mkdirSync(sourceDir, { recursive: true });

      writeFileSync(
        join(sourceDir, "custom-helper.md"),
        `---
name: custom-helper
description: "Foreign helper"
role: unknown-alien-role
---
Custom prompt body.`
      );

      const report = await runAgentsImport({
        from: "claude",
        sourceDir,
        targetDir,
        cwd: projectDir,
      });

      expect(report.imported).toContain("custom-helper");

      const content = readFileSync(join(targetDir, "custom-helper.md"), "utf8");
      expect(content).toContain("role: worker");
    });

    it("converts OpenCode agent definitions to Substrate agent format", async () => {
      const { runAgentsImport } = await loadAgentsImportModule();

      const sourceDir = join(tmpDir, "foreign-opencode");
      const targetDir = join(projectDir, ".substrate", "agents");
      mkdirSync(sourceDir, { recursive: true });

      writeFileSync(
        join(sourceDir, "analyzer.json"),
        JSON.stringify({
          name: "analyzer",
          description: "Static analyzer",
          model: "local-llama",
          systemPrompt: "You analyze code for AST defects.",
        })
      );

      const report = await runAgentsImport({
        from: "opencode",
        sourceDir,
        targetDir,
        cwd: projectDir,
      });

      expect(report.errors).toEqual([]);
      expect(report.imported).toContain("analyzer");

      const convertedFile = join(targetDir, "analyzer.md");
      expect(existsSync(convertedFile)).toBe(true);

      const content = readFileSync(convertedFile, "utf8");
      expect(content).toContain("name: analyzer");
      expect(content).toContain("role: worker");
      expect(content).toContain("You analyze code for AST defects.");
    });

    it("supports --dry-run: reports imported without writing files to disk", async () => {
      const { runAgentsImport } = await loadAgentsImportModule();

      const sourceDir = join(tmpDir, "claude-dry");
      const targetDir = join(projectDir, ".substrate", "agents-dry");
      mkdirSync(sourceDir, { recursive: true });

      writeFileSync(
        join(sourceDir, "dry-agent.md"),
        `---
name: dry-agent
description: "Dry run test"
---
System prompt.`
      );

      const report = await runAgentsImport({
        from: "claude",
        sourceDir,
        targetDir,
        dryRun: true,
        cwd: projectDir,
      });

      expect(report.imported).toContain("dry-agent");
      expect(existsSync(join(targetDir, "dry-agent.md"))).toBe(false);
    });

    it("skips existing agent files when --overwrite is false and records in skipped", async () => {
      const { runAgentsImport } = await loadAgentsImportModule();

      const sourceDir = join(tmpDir, "claude-skip");
      const targetDir = join(projectDir, ".substrate", "agents");
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });

      const targetFile = join(targetDir, "existing.md");
      writeFileSync(targetFile, "ORIGINAL CONTENT");

      writeFileSync(
        join(sourceDir, "existing.md"),
        `---
name: existing
description: "Foreign new content"
---
NEW CONTENT`
      );

      const report = await runAgentsImport({
        from: "claude",
        sourceDir,
        targetDir,
        overwrite: false,
        cwd: projectDir,
      });

      expect(report.skipped).toContain("existing");
      expect(report.imported).not.toContain("existing");
      expect(readFileSync(targetFile, "utf8")).toBe("ORIGINAL CONTENT");
    });

    it("overwrites existing agent files when --overwrite is true", async () => {
      const { runAgentsImport } = await loadAgentsImportModule();

      const sourceDir = join(tmpDir, "claude-overwrite");
      const targetDir = join(projectDir, ".substrate", "agents");
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });

      const targetFile = join(targetDir, "overwrite-me.md");
      writeFileSync(targetFile, "ORIGINAL CONTENT");

      writeFileSync(
        join(sourceDir, "overwrite-me.md"),
        `---
name: overwrite-me
description: "New description"
---
UPDATED CONTENT`
      );

      const report = await runAgentsImport({
        from: "claude",
        sourceDir,
        targetDir,
        overwrite: true,
        cwd: projectDir,
      });

      expect(report.imported).toContain("overwrite-me");
      expect(readFileSync(targetFile, "utf8")).toContain("UPDATED CONTENT");
    });

    it("reports error when source directory does not exist", async () => {
      const { runAgentsImport } = await loadAgentsImportModule();

      const report = await runAgentsImport({
        from: "claude",
        sourceDir: join(tmpDir, "does-not-exist"),
        targetDir: join(projectDir, ".substrate", "agents"),
        cwd: projectDir,
      });

      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.imported).toEqual([]);
    });
  });
});
