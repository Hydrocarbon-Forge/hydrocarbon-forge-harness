#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");

/**
 * Normalizes heading text into an anchor slug.
 */
function slugifyHeading(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // strip markdown links
    .replace(/[`*_~]/g, "") // strip markdown format characters
    .replace(/[^\w\s-]/g, "") // remove non-alphanumeric except whitespace/hyphen
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Collects all markdown files recursively under a directory.
 */
function collectMarkdownFiles(dir, skip = []) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.includes(full)) continue;
      results.push(...collectMarkdownFiles(full, skip));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Main documentation check function.
 */
export async function checkDocs(opts = {}) {
  const rootDir = opts.rootDir ? path.resolve(opts.rootDir) : defaultRoot;
  const docsDir = opts.docsDir ? path.resolve(opts.docsDir) : path.join(rootDir, "docs");
  const readmePath = opts.readmePath ? path.resolve(opts.readmePath) : path.join(rootDir, "README.md");

  const diagnostics = [];
  let checkedFiles = 0;
  let checkedLinks = 0;

  // Step 1: Verify presence of all expected markdown documents
  const requiredDocs = [
    { name: "README.md", path: readmePath },
    { name: "docs/reference/config.md", path: path.join(docsDir, "reference", "config.md") },
    { name: "docs/reference/cli.md", path: path.join(docsDir, "reference", "cli.md") },
    { name: "docs/reference/adapters.md", path: path.join(docsDir, "reference", "adapters.md") },
  ];

  for (const req of requiredDocs) {
    if (!fs.existsSync(req.path)) {
      diagnostics.push({
        file: req.path,
        rule: "missing_file",
        message: `Missing required documentation file: ${req.name}`,
      });
    }
  }

  // Collect all documentation files to inspect
  const allDocFiles = new Set();
  if (fs.existsSync(readmePath)) allDocFiles.add(readmePath);
  // docs/archive is frozen history and docs/plan is the disposable work-order set; neither is user-facing documentation.
  const skipDirs = [path.join(docsDir, "archive"), path.join(docsDir, "plan")];
  for (const file of collectMarkdownFiles(docsDir, skipDirs)) {
    allDocFiles.add(file);
  }

  // Pre-parse heading anchors for all doc files
  const fileAnchors = new Map();
  for (const file of allDocFiles) {
    const content = fs.readFileSync(file, "utf8");
    const anchors = new Set();
    const headingRegex = /^#{1,6}\s+(.+)$/gm;
    let m;
    while ((m = headingRegex.exec(content)) !== null) {
      const headingText = m[1].trim();
      anchors.add(slugifyHeading(headingText));
      anchors.add(headingText.toLowerCase().replace(/[`*_~]/g, "").trim());
    }
    fileAnchors.set(file, anchors);
  }

  // Step 2 & Step 5: Check relative links and code block fences in all markdown files
  for (const file of allDocFiles) {
    checkedFiles++;
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");

    let inFence = false;
    let fenceOpenLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // Step 5: Check code block fences
      if (trimmed.startsWith("```")) {
        if (!inFence) {
          inFence = true;
          fenceOpenLine = lineNum;
          const tag = trimmed.slice(3).trim();
          if (!tag) {
            diagnostics.push({
              file,
              line: lineNum,
              rule: "broken_link",
              message: `Code block fence missing language tag at line ${lineNum}`,
            });
          }
        } else {
          inFence = false;
        }
        continue;
      }

      // Skip link checks inside code blocks
      if (inFence) continue;

      // Step 2: Parse markdown links [text](target)
      const linkRegex = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
      let lm;
      while ((lm = linkRegex.exec(line)) !== null) {
        checkedLinks++;
        const rawTarget = lm[1].trim();

        // Skip non-relative schemes
        if (
          rawTarget.startsWith("http:") ||
          rawTarget.startsWith("https:") ||
          rawTarget.startsWith("mailto:") ||
          rawTarget.startsWith("ftp:") ||
          rawTarget.startsWith("file:")
        ) {
          continue;
        }

        let targetPath = rawTarget;
        let anchor = null;
        const hashIdx = rawTarget.indexOf("#");
        if (hashIdx !== -1) {
          targetPath = rawTarget.slice(0, hashIdx);
          anchor = rawTarget.slice(hashIdx + 1);
        }

        const resolvedTargetFile = targetPath
          ? path.resolve(path.dirname(file), targetPath)
          : file;

        if (!fs.existsSync(resolvedTargetFile)) {
          diagnostics.push({
            file,
            line: lineNum,
            rule: "broken_link",
            message: `Broken relative link "${rawTarget}": target file does not exist`,
          });
          continue;
        }

        if (anchor) {
          const targetAnchors = fileAnchors.get(resolvedTargetFile);
          if (targetAnchors) {
            const normalizedAnchor = slugifyHeading(anchor);
            const lowerAnchor = anchor.toLowerCase();
            if (!targetAnchors.has(normalizedAnchor) && !targetAnchors.has(lowerAnchor)) {
              diagnostics.push({
                file,
                line: lineNum,
                rule: "broken_link",
                message: `Broken anchor link "${rawTarget}": anchor #${anchor} not found in ${path.relative(rootDir, resolvedTargetFile)}`,
              });
            }
          }
        }
      }
    }

    if (inFence) {
      diagnostics.push({
        file,
        line: fenceOpenLine,
        rule: "broken_link",
        message: `Unclosed code block fence opened at line ${fenceOpenLine}`,
      });
    }
  }

  // Step 3: Scan CLI command names and verify documentation in docs/reference/cli.md
  const cliDocPath = path.join(docsDir, "reference", "cli.md");
  const cliDocContent = fs.existsSync(cliDocPath) ? fs.readFileSync(cliDocPath, "utf8") : "";
  const cliHeadings = [];
  const cliHeadingRegex = /^#{1,6}\s+(.+)$/gm;
  let chm;
  while ((chm = cliHeadingRegex.exec(cliDocContent)) !== null) {
    cliHeadings.push(chm[1].toLowerCase().replace(/[`*_~]/g, "").trim());
  }

  const cliCommands = new Set();
  const commandsDir = path.join(rootDir, "src", "cli", "commands");
  const nameRegex = /\bname:\s*["']([a-z0-9:_-]+)["']/;

  if (fs.existsSync(commandsDir)) {
    for (const f of fs.readdirSync(commandsDir)) {
      if (f.endsWith(".ts")) {
        const c = fs.readFileSync(path.join(commandsDir, f), "utf8");
        const m = nameRegex.exec(c);
        if (m) cliCommands.add(m[1]);
      }
    }
  }

  for (const extraFile of ["src/cli/bench.ts", "src/cli/agents-import.ts"]) {
    const fullExtra = path.join(rootDir, extraFile);
    if (fs.existsSync(fullExtra)) {
      const c = fs.readFileSync(fullExtra, "utf8");
      const m = nameRegex.exec(c);
      if (m) cliCommands.add(m[1]);
    }
  }

  for (const cmd of cliCommands) {
    const normalizedCmd = cmd.replace(":", "-");
    const isDocumented = cliHeadings.some((h) => {
      return (
        h === cmd ||
        h === normalizedCmd ||
        h.includes(` ${cmd}`) ||
        h.includes(` ${normalizedCmd}`) ||
        h.startsWith(`${cmd} `) ||
        h.startsWith(`${normalizedCmd} `)
      );
    });

    if (!isDocumented) {
      diagnostics.push({
        file: cliDocPath,
        rule: "missing_cli_doc",
        message: `CLI subcommand "${cmd}" is not documented in ${path.relative(rootDir, cliDocPath)}`,
      });
    }
  }

  // Step 4: Scan Contracts.Settings keys and verify documentation in docs/reference/config.md
  const configDocPath = path.join(docsDir, "reference", "config.md");
  const configDocContent = fs.existsSync(configDocPath) ? fs.readFileSync(configDocPath, "utf8") : "";
  const configHeadings = [];
  const configHeadingRegex = /^#{1,6}\s+(.+)$/gm;
  let cfgm;
  while ((cfgm = configHeadingRegex.exec(configDocContent)) !== null) {
    configHeadings.push(cfgm[1].toLowerCase().replace(/[`*_~]/g, "").trim());
  }

  let settingsKeys = [
    "backends",
    "roles",
    "routing",
    "pricing",
    "budgets",
    "concurrency",
    "permissions",
    "sandbox",
    "git",
    "instructions",
    "execution",
    "hooks",
  ];

  try {
    const contractsMod = await import(pathToFileURL(path.join(rootDir, "src/contracts/index.ts")).href);
    if (contractsMod.Settings && contractsMod.Settings.shape) {
      settingsKeys = Object.keys(contractsMod.Settings.shape);
    }
  } catch {}

  for (const key of settingsKeys) {
    const isDocumented = configHeadings.some((h) => {
      return h === key || h.includes(` ${key}`) || h.startsWith(`${key} `);
    });

    if (!isDocumented) {
      diagnostics.push({
        file: configDocPath,
        rule: "missing_config_doc",
        message: `Settings key "${key}" is not documented in ${path.relative(rootDir, configDocPath)}`,
      });
    }
  }

  return {
    ok: diagnostics.length === 0,
    checkedFiles,
    checkedLinks,
    diagnostics,
  };
}

// CLI runner execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const res = await checkDocs();
    if (!res.ok) {
      for (const d of res.diagnostics) {
        console.error(`${d.file}${d.line ? `:${d.line}` : ""}: [${d.rule}] ${d.message}`);
      }
      process.exit(1);
    }
    console.log(`Documentation check passed: ${res.checkedFiles} files checked, ${res.checkedLinks} links verified.`);
    process.exit(0);
  } catch (err) {
    console.error(`Documentation check failed with error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
