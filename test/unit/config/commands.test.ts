import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type * as Contracts from "../../../src/contracts/index.js";

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

async function loadAgentsImportModule(): Promise<{
  runAgentsImport: (opts: AgentsImportOptions) => Promise<ImportReport>;
}> {
  return (await import("../../../src/cli/agents-import.js" as any)) as any;
}

describe("foreign agents import", () => {
  let tmpDir: string;
  let projectDir: string;
  let userDir: string;
  let builtinDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "substrate-cfg-cmd-test-"));
    projectDir = join(tmpDir, "project");
    userDir = join(tmpDir, "user");
    builtinDir = join(tmpDir, "builtin");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("agents import: foreign conversion", () => {
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
