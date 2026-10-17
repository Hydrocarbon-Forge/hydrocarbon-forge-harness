import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import YAML from "yaml";

import type { BenchmarkTaskSpec } from "./types.js";

function collectAllMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectAllMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function loadBenchmarkTasks(
  taskDirOrGlobs: string[],
  cwd: string = process.cwd()
): Promise<BenchmarkTaskSpec[]> {
  const matchedFilePaths = new Set<string>();

  for (const pattern of taskDirOrGlobs) {
    const directPath = path.isAbsolute(pattern)
      ? pattern
      : path.resolve(cwd, pattern);

    if (fs.existsSync(directPath)) {
      const stat = fs.statSync(directPath);
      if (stat.isFile()) {
        matchedFilePaths.add(directPath);
        continue;
      }
      if (stat.isDirectory()) {
        const mdFiles = collectAllMdFiles(directPath);
        for (const file of mdFiles) {
          matchedFilePaths.add(file);
        }
        continue;
      }
    }

    // Pattern contains glob or is a glob expression
    // Find all .md files under cwd or pattern base
    const allFiles = collectAllMdFiles(cwd);
    const isMatch = picomatch(pattern, { dot: true });

    for (const file of allFiles) {
      const relPath = path.relative(cwd, file).replace(/\\/g, "/");
      const normalizedFull = file.replace(/\\/g, "/");
      if (isMatch(relPath) || isMatch(normalizedFull)) {
        matchedFilePaths.add(file);
      }
    }
  }

  const tasks: BenchmarkTaskSpec[] = [];

  for (const filePath of matchedFilePaths) {
    const content = fs.readFileSync(filePath, "utf8");
    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    if (lines.length === 0 || lines[0].trim() !== "---") {
      throw new Error(
        `Invalid task file ${filePath}: missing frontmatter start delimiter '---' or malformed frontmatter`
      );
    }

    let closingIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        closingIdx = i;
        break;
      }
    }

    if (closingIdx === -1) {
      throw new Error(
        `Invalid task file ${filePath}: missing frontmatter end delimiter '---' or malformed frontmatter`
      );
    }

    const rawYaml = lines.slice(1, closingIdx).join("\n");
    const body = lines.slice(closingIdx + 1).join("\n");

    let parsed: any;
    try {
      parsed = YAML.parse(rawYaml);
    } catch (err: any) {
      throw new Error(
        `Invalid YAML frontmatter in ${filePath}: ${err.message}`
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(
        `Malformed frontmatter in ${filePath}: expected key-value mapping`
      );
    }

    // Validate required fields
    if (!parsed.id || typeof parsed.id !== "string" || parsed.id.trim() === "") {
      throw new Error(`Task specification in ${filePath} missing required field 'id'`);
    }
    if (!parsed.title || typeof parsed.title !== "string" || parsed.title.trim() === "") {
      throw new Error(`Task specification in ${filePath} missing required field 'title'`);
    }
    if (!parsed.task_class || typeof parsed.task_class !== "string" || parsed.task_class.trim() === "") {
      throw new Error(`Task specification in ${filePath} missing required field 'task_class'`);
    }
    if (!parsed.repo_fixture || typeof parsed.repo_fixture !== "string" || parsed.repo_fixture.trim() === "") {
      throw new Error(`Task specification in ${filePath} missing required field 'repo_fixture'`);
    }
    if (!Array.isArray(parsed.verify) || parsed.verify.length === 0) {
      throw new Error("Task must specify at least one verification command");
    }

    // Fixture path check
    const fixturePath = parsed.repo_fixture;
    let resolvedFixture = path.isAbsolute(fixturePath)
      ? fixturePath
      : path.resolve(cwd, fixturePath);

    if (!fs.existsSync(resolvedFixture)) {
      const relToTask = path.resolve(path.dirname(filePath), fixturePath);
      if (fs.existsSync(relToTask)) {
        resolvedFixture = relToTask;
      } else {
        throw new Error(`Fixture path not found: ${fixturePath}`);
      }
    }

    const trimmedBody = body.trim();
    const description = trimmedBody.length > 0 ? trimmedBody : parsed.description;

    const taskSpec: BenchmarkTaskSpec = {
      id: parsed.id,
      title: parsed.title,
      task_class: parsed.task_class,
      repo_fixture: parsed.repo_fixture,
      verify: parsed.verify,
      budget: parsed.budget ?? { max_usd: 2.0 },
    };

    if (parsed.tags && Array.isArray(parsed.tags)) {
      taskSpec.tags = parsed.tags;
    }
    if (parsed.base_commit) {
      taskSpec.base_commit = parsed.base_commit;
    }
    if (parsed.setup && Array.isArray(parsed.setup)) {
      taskSpec.setup = parsed.setup;
    }
    if (description) {
      taskSpec.description = description;
    }

    tasks.push(taskSpec);
  }

  return tasks;
}
