import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  Manifest,
  TaskSpecFrontmatter,
  type TaskId,
  type Command,
  type Diagnostic,
  type Settings,
  type VerifyResult,
} from "../contracts/index.js";

export interface CodeBlock {
  lang: string;
  code: string;
  lineStart: number;
  lineCount: number;
}

export interface ParsedTaskSpec {
  frontmatter: TaskSpecFrontmatter;
  rawFrontmatter: string;
  body: string;
  sections: Map<string, string>;
  codeBlocks: CodeBlock[];
  filePath: string;
}

export interface ParsedPlan {
  manifest: Manifest;
  specs: Map<TaskId, ParsedTaskSpec>;
  rawManifest: string;
  manifestPath: string;
}

export function parseManifest(content: string, filePath?: string): Manifest {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      `Manifest content is empty in ${filePath ?? "manifest"}`
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (err: any) {
    throw new Error(
      `Failed to parse manifest YAML in ${filePath ?? "manifest"}: ${err?.message ?? String(err)}`
    );
  }

  const res = Manifest.parse(parsed);
  return res;
}

export function parseTaskSpec(content: string, filePath?: string): ParsedTaskSpec {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`Task spec content is empty in ${filePath ?? "spec"}`);
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0].trim() !== "---") {
    throw new Error(
      `Task spec must begin with frontmatter fence '---' in ${filePath ?? "spec"}`
    );
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    throw new Error(
      `Task spec missing closing frontmatter fence '---' in ${filePath ?? "spec"}`
    );
  }

  const rawFrontmatter = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n");

  let parsedYaml: unknown;
  try {
    parsedYaml = YAML.parse(rawFrontmatter);
  } catch (err: any) {
    throw new Error(
      `Failed to parse task spec frontmatter YAML in ${filePath ?? "spec"}: ${err?.message ?? String(err)}`
    );
  }

  const frontmatter = TaskSpecFrontmatter.parse(parsedYaml);

  const bodyLines = lines.slice(endIdx + 1);
  const sections = new Map<string, string>();
  const codeBlocks: CodeBlock[] = [];

  let inCode = false;
  let codeLang = "";
  let codeStartLine = 0;
  let codeLines: string[] = [];

  let currentHeading: string | null = null;
  let currentContentLines: string[] = [];

  for (let j = 0; j < bodyLines.length; j++) {
    const line = bodyLines[j];
    const fileLine = endIdx + 2 + j;

    if (!inCode && line.startsWith("```")) {
      inCode = true;
      const m = line.match(/^```(\w*)/);
      codeLang = m ? m[1] : "";
      codeStartLine = fileLine;
      codeLines = [];
    } else if (inCode && line.startsWith("```")) {
      inCode = false;
      codeBlocks.push({
        lang: codeLang,
        code: codeLines.join("\n"),
        lineStart: codeStartLine,
        lineCount: codeLines.length,
      });
    } else if (inCode) {
      codeLines.push(line);
    }

    if (!inCode) {
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        if (currentHeading !== null) {
          sections.set(currentHeading, currentContentLines.join("\n").trim());
        }
        currentHeading = headingMatch[1].trim();
        currentContentLines = [];
        continue;
      }
    }

    if (currentHeading !== null) {
      currentContentLines.push(line);
    }
  }

  if (currentHeading !== null) {
    sections.set(currentHeading, currentContentLines.join("\n").trim());
  }

  // Placeholder tokens (rule L013) are a warning, never a throw: the lint rule reports them through
  // findPlaceholders, so a spec that loads is never refused for them (DECISIONS, R12.3).

  return {
    frontmatter,
    rawFrontmatter,
    body,
    sections,
    codeBlocks,
    filePath: filePath ?? "",
  };
}
