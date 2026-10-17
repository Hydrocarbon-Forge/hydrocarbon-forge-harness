import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { RoleName } from "../contracts/index.js";

export interface CommandContext {
  cwd: string;
  flags: Record<string, any>;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: any;
  sessionStore?: any;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`./registry.js`);

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

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: raw };
  }
  try {
    const parsed = YAML.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontmatter: null, body: raw };
    }
    return { frontmatter: parsed as Record<string, unknown>, body: match[2].trim() };
  } catch {
    return { frontmatter: null, body: raw };
  }
}

export async function runAgentsImport(opts: AgentsImportOptions): Promise<ImportReport> {
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const cwd = opts.cwd ?? process.cwd();
  const sourceDir = opts.sourceDir
    ? path.resolve(cwd, opts.sourceDir)
    : path.resolve(cwd, opts.from === "claude" ? ".claude/agents" : ".opencode/agents");
  const targetDir = opts.targetDir
    ? path.resolve(cwd, opts.targetDir)
    : path.resolve(cwd, ".substrate/agents");

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return {
      imported: [],
      skipped: [],
      errors: [`Source directory does not exist: ${sourceDir}`],
    };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(sourceDir).sort();
  } catch (err: any) {
    return {
      imported: [],
      skipped: [],
      errors: [`Failed to read source directory: ${err?.message ?? String(err)}`],
    };
  }

  for (const file of entries) {
    const filePath = path.join(sourceDir, file);
    if (!fs.statSync(filePath).isFile()) {
      continue;
    }

    let name: string = "";
    let description: string = "";
    let role: RoleName = "worker";
    let model: string | undefined;
    let tools: string[] | undefined;
    let disallowedTools: string[] | undefined;
    let permissionMode: string | undefined;
    let body: string = "";

    if (opts.from === "claude") {
      if (!file.endsWith(".md")) {
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch (err: any) {
        errors.push(`Failed to read file ${file}: ${err?.message ?? String(err)}`);
        continue;
      }

      const parsed = parseFrontmatter(content);
      const fm = parsed.frontmatter ?? {};
      name = (typeof fm.name === "string" && fm.name) || path.basename(file, ".md");
      description = (typeof fm.description === "string" && fm.description) || "";

      if (fm.role !== undefined) {
        const roleResult = RoleName.safeParse(fm.role);
        role = roleResult.success ? roleResult.data : "worker";
      } else {
        role = "worker";
      }

      model = typeof fm.model === "string" ? fm.model : undefined;
      tools = Array.isArray(fm.tools) ? (fm.tools as string[]) : undefined;
      disallowedTools = Array.isArray(fm.disallowedTools)
        ? (fm.disallowedTools as string[])
        : undefined;
      permissionMode = typeof fm.permissionMode === "string" ? fm.permissionMode : undefined;
      body = parsed.body;
    } else if (opts.from === "opencode") {
      if (file.endsWith(".json")) {
        let content: string;
        try {
          content = fs.readFileSync(filePath, "utf8");
        } catch (err: any) {
          errors.push(`Failed to read file ${file}: ${err?.message ?? String(err)}`);
          continue;
        }

        let data: Record<string, any>;
        try {
          data = JSON.parse(content);
        } catch (err: any) {
          errors.push(`Failed to parse JSON file ${file}: ${err?.message ?? String(err)}`);
          continue;
        }

        name = (typeof data.name === "string" && data.name) || path.basename(file, ".json");
        description = (typeof data.description === "string" && data.description) || "";
        model = typeof data.model === "string" ? data.model : undefined;
        role = "worker";
        body = data.systemPrompt ?? data.prompt ?? data.body ?? "";
      } else if (file.endsWith(".md")) {
        let content: string;
        try {
          content = fs.readFileSync(filePath, "utf8");
        } catch (err: any) {
          errors.push(`Failed to read file ${file}: ${err?.message ?? String(err)}`);
          continue;
        }

        const parsed = parseFrontmatter(content);
        const fm = parsed.frontmatter ?? {};
        name = (typeof fm.name === "string" && fm.name) || path.basename(file, ".md");
        description = (typeof fm.description === "string" && fm.description) || "";
        model = typeof fm.model === "string" ? fm.model : undefined;
        role = "worker";
        body = parsed.body;
      } else {
        continue;
      }
    }

    if (!name) {
      errors.push(`Could not determine agent name for ${file}`);
      continue;
    }

    const targetFile = path.join(targetDir, `${name}.md`);

    if (fs.existsSync(targetFile) && !opts.overwrite) {
      skipped.push(name);
      continue;
    }

    if (opts.dryRun) {
      imported.push(name);
      continue;
    }

    if (!fs.existsSync(targetDir)) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (err: any) {
        errors.push(`Failed to create target directory ${targetDir}: ${err?.message ?? String(err)}`);
        continue;
      }
    }

    const outFrontmatter: Record<string, unknown> = {
      name,
      description,
      role,
    };
    if (model) outFrontmatter.model = model;
    if (tools && tools.length > 0) outFrontmatter.tools = tools;
    if (disallowedTools && disallowedTools.length > 0) {
      outFrontmatter.disallowedTools = disallowedTools;
    }
    if (permissionMode) outFrontmatter.permissionMode = permissionMode;

    const yamlStr = YAML.stringify(outFrontmatter).trim();
    const fileContent = `---\n${yamlStr}\n---\n${body}\n`;

    try {
      fs.writeFileSync(targetFile, fileContent, "utf8");
      imported.push(name);
    } catch (err: any) {
      errors.push(`Failed to write agent file ${targetFile}: ${err?.message ?? String(err)}`);
    }
  }

  return { imported, skipped, errors };
}

export const agentsImportCommand: CliCommand = {
  name: "agents:import",
  aliases: ["agents-import", "agents import"],
  description: "Import agent definitions from foreign formats (Claude, OpenCode)",
  async execute(ctx: CommandContext): Promise<number> {
    let rawArgs = ctx.rawArgs;
    // Strip command prefixes if present
    if (rawArgs[0] === "agents" && rawArgs[1] === "import") {
      rawArgs = rawArgs.slice(2);
    } else if (rawArgs[0] === "agents:import" || rawArgs[0] === "agents-import" || rawArgs[0] === "agents import") {
      rawArgs = rawArgs.slice(1);
    }

    let parsed: any;
    try {
      parsed = parseArgs({
        args: rawArgs,
        options: {
          from: { type: "string" },
          source: { type: "string" },
          "source-dir": { type: "string" },
          target: { type: "string" },
          "target-dir": { type: "string" },
          overwrite: { type: "boolean" },
          "dry-run": { type: "boolean" },
        },
        allowPositionals: true,
        strict: false,
      });
    } catch (err: any) {
      ctx.stderr.write(`Error parsing arguments: ${err?.message}\n`);
      return 2;
    }

    const fromVal = parsed.values.from;
    if (fromVal !== "claude" && fromVal !== "opencode") {
      ctx.stderr.write("Usage: substrate agents import --from <claude|opencode> [options]\n");
      ctx.stderr.write("Error: --from flag must be 'claude' or 'opencode'\n");
      return 2;
    }

    const sourceDir = parsed.values["source-dir"] ?? parsed.values.source;
    const targetDir = parsed.values["target-dir"] ?? parsed.values.target;
    const overwrite = Boolean(parsed.values.overwrite);
    const dryRun = Boolean(parsed.values["dry-run"]);

    const report = await runAgentsImport({
      from: fromVal,
      sourceDir,
      targetDir,
      overwrite,
      dryRun,
      cwd: ctx.cwd,
    });

    if (report.errors.length > 0) {
      for (const err of report.errors) {
        ctx.stderr.write(`Error: ${err}\n`);
      }
      if (report.errors.some((e) => e.includes("Source directory does not exist"))) {
        return 2;
      }
      return 1;
    }

    ctx.stdout.write(`=== Agents Import Summary ===\n`);
    ctx.stdout.write(`Imported: ${report.imported.length} (${report.imported.join(", ") || "none"})\n`);
    ctx.stdout.write(`Skipped:  ${report.skipped.length} (${report.skipped.join(", ") || "none"})\n`);

    return 0;
  },
};

registry.register(agentsImportCommand);
