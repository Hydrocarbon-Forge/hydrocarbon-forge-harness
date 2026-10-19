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

const DOC_RULES = ["DOC-FLAG", "DOC-CMD", "DOC-ENV", "DOC-KEY"];

/**
 * Recursively lists files under dir whose names end with one of exts, sorted by path.
 */
function walkFiles(dir, exts) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, exts));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results.sort();
}

/**
 * Splits markdown into lines, marking which ones sit inside a fenced code block.
 */
function markdownLines(content) {
  const rows = [];
  let inFence = false;
  content.split("\n").forEach((text, i) => {
    if (text.trim().startsWith("```")) {
      inFence = !inFence;
      rows.push({ line: i + 1, text, code: false, fence: true });
    } else {
      rows.push({ line: i + 1, text, code: inFence, fence: false });
    }
  });
  return rows;
}

/**
 * Returns the reference documents the DOC-FLAG, DOC-CMD and DOC-ENV rules read.
 */
function docRuleFiles(rootDir) {
  const refDir = path.join(rootDir, "docs", "reference");
  const refFiles = fs.existsSync(refDir)
    ? fs.readdirSync(refDir).filter((n) => n.endsWith(".md")).sort().map((n) => path.join(refDir, n))
    : [];
  return [path.join(rootDir, "README.md"), ...refFiles].filter((f) => fs.existsSync(f));
}

/**
 * The command modules beside the dispatcher (src/cli/*.ts, not commands/) that
 * src/cli/dispatcher.ts itself loads, such as bench. A module the dispatcher
 * never loads registers nothing, so it is not a command.
 */
function dispatcherLoadedModules(rootDir) {
  const dispatcher = path.join(rootDir, "src", "cli", "dispatcher.ts");
  const files = [];
  if (!fs.existsSync(dispatcher)) return files;
  const loaded = fs.readFileSync(dispatcher, "utf8");
  for (const m of loaded.matchAll(/import\(\s*[`"']\.\/([a-z0-9-]+)\.js[`"']\s*\)/g)) {
    const full = path.join(rootDir, "src", "cli", `${m[1]}.ts`);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

/**
 * Collects the command names and aliases registered in src/cli/commands/*.ts
 * and in the modules the dispatcher loads.
 */
function registeredCommands(rootDir) {
  const names = new Set();
  const dir = path.join(rootDir, "src", "cli", "commands");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".ts")).sort().map((n) => path.join(dir, n)) : [];
  files.push(...dispatcherLoadedModules(rootDir));
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const nameMatch = /^ {2}name:\s*["']([a-z0-9:_-]+)["']/m.exec(content);
    if (nameMatch) names.add(nameMatch[1]);
    const aliasMatch = /^ {2}aliases:\s*\[([^\]]*)\]/m.exec(content);
    if (aliasMatch) {
      for (const a of aliasMatch[1].matchAll(/["']([a-z0-9:_-]+)["']/g)) names.add(a[1]);
    }
  }
  return names;
}

/**
 * Reads the CLI_OPTIONS keys from src/cli/dispatcher.ts and the literal flag and
 * quoted names used by the other files under src/cli/.
 */
function knownCliFlags(rootDir) {
  const cliDir = path.join(rootDir, "src", "cli");
  const dispatcher = path.join(cliDir, "dispatcher.ts");
  const keys = new Set();
  const literals = new Set();
  if (fs.existsSync(dispatcher)) {
    const content = fs.readFileSync(dispatcher, "utf8");
    const block = /CLI_OPTIONS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(content);
    if (block) {
      for (const m of block[1].matchAll(/^\s*"?([a-z][a-z0-9-]*)"?\s*:\s*\{/gm)) keys.add(m[1]);
    }
  }
  for (const file of walkFiles(cliDir, [".ts", ".js"])) {
    if (file === dispatcher) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const m of content.matchAll(/--([a-z][a-z0-9-]*)/g)) literals.add(m[1]);
    for (const m of content.matchAll(/["']([a-z][a-z0-9-]*)["']/g)) literals.add(m[1]);
  }
  return { keys, literals };
}

/**
 * Runs the DOC-FLAG, DOC-CMD, DOC-ENV and DOC-KEY rules. Violations are pushed into
 * diagnostics; the return value counts the checks made per rule.
 */
function checkDocRules(rootDir, diagnostics) {
  const checks = Object.fromEntries(DOC_RULES.map((r) => [r, 0]));
  const report = (rule, file, line, message) => {
    diagnostics.push({ file, line, rule, message });
  };

  const commands = registeredCommands(rootDir);
  const flags = knownCliFlags(rootDir);
  const srcFiles = walkFiles(path.join(rootDir, "src"), [".ts", ".js"]);
  const srcText = srcFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");

  for (const file of docRuleFiles(rootDir)) {
    const rows = markdownLines(fs.readFileSync(file, "utf8"));
    for (const row of rows) {
      // DOC-FLAG: every --flag token, prose or code, must be a known CLI option.
      for (const m of row.text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) {
        checks["DOC-FLAG"]++;
        if (!flags.keys.has(m[1]) && !flags.literals.has(m[1])) {
          report("DOC-FLAG", file, row.line, `flag "--${m[1]}" is not in CLI_OPTIONS or src/cli/`);
        }
      }

      // DOC-ENV: every SUBSTRATE_ variable must appear literally in src/.
      for (const m of row.text.matchAll(/(?<![A-Za-z0-9_])SUBSTRATE_[A-Z_]+/g)) {
        checks["DOC-ENV"]++;
        if (!srcText.includes(m[0])) {
          report("DOC-ENV", file, row.line, `environment variable ${m[0]} does not appear in src/`);
        }
      }

      // DOC-CMD: `substrate <word>` in code only. A word must be a registered command or alias.
      // Quoted or dash-led words are a run prompt or a flag, and `substrate/` paths never match.
      if (row.fence) continue;
      const segments = row.code ? [row.text] : [...row.text.matchAll(/`([^`]*)`/g)].map((s) => s[1]);
      for (const segment of segments) {
        for (const m of segment.matchAll(/(?<![\w/.-])substrate[ \t]+([A-Za-z][\w:-]*)/g)) {
          checks["DOC-CMD"]++;
          if (!commands.has(m[1])) {
            report("DOC-CMD", file, row.line, `substrate ${m[1]} is not a registered command or alias in src/cli/commands/`);
          }
        }
      }
    }
  }

  // DOC-KEY: dotted keys in the first cell of a table row in config.md.
  const configDoc = path.join(rootDir, "docs", "reference", "config.md");
  if (fs.existsSync(configDoc)) {
    const keyLeafTexts = srcFiles
      .filter((f) => {
        const rel = path.relative(rootDir, f).split(path.sep).join("/");
        return !rel.startsWith("src/contracts/") && !rel.startsWith("src/config/") && rel !== "src/cli/commands/config.ts";
      })
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const row of markdownLines(fs.readFileSync(configDoc, "utf8"))) {
      if (!row.text.trim().startsWith("|") || /^\|?\s*:?-{3,}/.test(row.text.trim())) continue;
      const firstCell = row.text.trim().split("|")[1] ?? "";
      const keyMatch = /`([A-Za-z_][A-Za-z0-9_*]*(?:\.[A-Za-z0-9_*]+)+)`/.exec(firstCell);
      if (!keyMatch || keyMatch[1].includes("*")) continue;
      const key = keyMatch[1];
      const leaf = key.split(".").pop();
      const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const readPattern = new RegExp(`\\.${escaped}\\b|\\["${escaped}"\\]|\\['${escaped}'\\]`);
      checks["DOC-KEY"]++;
      if (!readPattern.test(keyLeafTexts)) {
        report("DOC-KEY", configDoc, row.line, `settings key "${key}" is not read as property "${leaf}" in src/`);
      }
    }
  }

  return checks;
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

  for (const fullExtra of dispatcherLoadedModules(rootDir)) {
    const c = fs.readFileSync(fullExtra, "utf8");
    const m = nameRegex.exec(c);
    if (m) cliCommands.add(m[1]);
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

  const checks = checkDocRules(rootDir, diagnostics);

  return {
    ok: diagnostics.length === 0,
    checkedFiles,
    checkedLinks,
    checks,
    diagnostics,
  };
}

/**
 * Parses the script arguments. Only --root is accepted; it defaults to the repository root.
 */
function parseArgs(args) {
  let root = defaultRoot;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = path.resolve(args[++i]);
    }
  }
  return root;
}

// CLI runner execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const rootDir = parseArgs(process.argv.slice(2));
    const res = await checkDocs({ rootDir });
    const legacy = res.diagnostics
      .filter((d) => !DOC_RULES.includes(d.rule))
      .sort((a, b) => `${a.file}`.localeCompare(`${b.file}`) || (a.line ?? 0) - (b.line ?? 0));
    const docViolations = res.diagnostics
      .filter((d) => DOC_RULES.includes(d.rule))
      .map((d) => ({ ...d, rel: path.relative(rootDir, d.file).split(path.sep).join("/") }))
      .sort((a, b) => a.rel.localeCompare(b.rel) || (a.line ?? 0) - (b.line ?? 0) || DOC_RULES.indexOf(a.rule) - DOC_RULES.indexOf(b.rule));

    for (const d of legacy) {
      console.error(`${d.file}${d.line ? `:${d.line}` : ""}: [${d.rule}] ${d.message}`);
    }
    for (const d of docViolations) {
      console.log(`${d.rule} ${d.rel}:${d.line} ${d.message}`);
    }

    console.log(`Documentation check: ${res.checkedFiles} files checked, ${res.checkedLinks} links verified.`);
    for (const rule of DOC_RULES) {
      console.log(`  ${rule} checks: ${res.checks[rule]}`);
    }
    const total = legacy.length + docViolations.length;
    if (total > 0) {
      console.log(`FAIL: ${total} violation(s)`);
      process.exit(1);
    }
    console.log("OK");
    process.exit(0);
  } catch (err) {
    console.error(`Documentation check failed with error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  }
}
