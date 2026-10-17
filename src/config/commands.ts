import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  model?: string;
  body: string;
  path: string;
  source: "project" | "user" | "builtin";
}

export interface LoadCommandDefinitionsOptions {
  projectDir?: string;
  userDir?: string;
  builtinDir?: string;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("Missing or malformed YAML frontmatter");
  }
  const parsed = YAML.parse(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAML frontmatter must be an object");
  }
  return { frontmatter: parsed as Record<string, unknown>, body: match[2] };
}

function resolveDir(baseDir: string | undefined, sub: string): string | null {
  if (!baseDir) return null;
  const target = path.join(baseDir, sub);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return target;
  }
  if (fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()) {
    return baseDir;
  }
  return null;
}

export async function loadCommandDefinitions(
  opts?: LoadCommandDefinitionsOptions
): Promise<{ commands: CommandDefinition[]; errors: Error[] }> {
  const commands: CommandDefinition[] = [];
  const errors: Error[] = [];
  const seen = new Set<string>();

  const projectDir = opts?.projectDir ?? process.cwd();
  const userDir = opts?.userDir ?? path.join(os.homedir(), ".config", "substrate");
  const builtinDir = opts?.builtinDir ?? path.resolve(process.cwd(), "assets");

  const tiers: Array<{ source: "project" | "user" | "builtin"; dir: string | null }> = [
    {
      source: "project",
      dir: resolveDir(projectDir, ".substrate/commands"),
    },
    {
      source: "user",
      dir: resolveDir(userDir, "commands"),
    },
    {
      source: "builtin",
      dir: resolveDir(builtinDir, "commands"),
    },
  ];

  for (const tier of tiers) {
    if (!tier.dir) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(tier.dir).filter((f) => f.endsWith(".md")).sort();
    } catch (e: any) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
      continue;
    }

    for (const file of entries) {
      const fullPath = path.join(tier.dir, file);
      const name = path.basename(file, ".md");

      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch (e: any) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
        continue;
      }

      let parsed: { frontmatter: Record<string, unknown>; body: string };
      try {
        parsed = parseFrontmatter(content);
      } catch (e: any) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
        continue;
      }

      if (seen.has(name)) {
        continue;
      }
      seen.add(name);

      const fm = parsed.frontmatter;
      const description = typeof fm.description === "string" ? fm.description : "";
      const argumentHint =
        typeof fm["argument-hint"] === "string"
          ? fm["argument-hint"]
          : typeof fm.argumentHint === "string"
            ? fm.argumentHint
            : undefined;
      const model = typeof fm.model === "string" ? fm.model : undefined;

      commands.push({
        name,
        description,
        argumentHint,
        model,
        body: parsed.body,
        path: fullPath,
        source: tier.source,
      });
    }
  }

  return { commands, errors };
}

export async function resolveCommand(
  name: string,
  projectDir?: string,
  opts?: { userDir?: string; builtinDir?: string }
): Promise<CommandDefinition | null> {
  const { commands } = await loadCommandDefinitions({
    projectDir,
    userDir: opts?.userDir,
    builtinDir: opts?.builtinDir,
  });
  return commands.find((c) => c.name === name) ?? null;
}

export function expandCommandTemplate(body: string, args: string): string {
  const trimmedArgs = args.trim();
  if (body.includes("$ARGUMENTS")) {
    if (trimmedArgs.length > 0) {
      return body.replaceAll("$ARGUMENTS", trimmedArgs);
    } else {
      return body
        .replaceAll("$ARGUMENTS", "")
        .replace(/[ \t]+([.,;:!?])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    }
  } else {
    if (trimmedArgs.length > 0) {
      return `${body.trim()} ${trimmedArgs}`;
    } else {
      return body;
    }
  }
}
