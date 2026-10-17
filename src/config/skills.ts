import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source: "project" | "user" | "builtin";
}

export interface SkillDefinition extends SkillSummary {
  body: string;
}

export interface LoadSkillSummariesOptions {
  projectDir?: string;
  userDir?: string;
  builtinDir?: string;
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
    return { frontmatter: parsed as Record<string, unknown>, body: match[2] };
  } catch {
    return { frontmatter: null, body: raw };
  }
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

export async function loadSkillSummaries(
  opts?: LoadSkillSummariesOptions
): Promise<{ skills: SkillSummary[]; errors: Error[] }> {
  const skills: SkillSummary[] = [];
  const errors: Error[] = [];
  const seen = new Set<string>();

  const projectDir = opts?.projectDir ?? process.cwd();
  const userDir = opts?.userDir ?? path.join(os.homedir(), ".config", "substrate");
  const builtinDir = opts?.builtinDir ?? path.resolve(process.cwd(), "assets");

  const tiers: Array<{ source: "project" | "user" | "builtin"; dir: string | null }> = [
    {
      source: "project",
      dir: resolveDir(projectDir, ".substrate/skills"),
    },
    {
      source: "user",
      dir: resolveDir(userDir, "skills"),
    },
    {
      source: "builtin",
      dir: resolveDir(builtinDir, "skills"),
    },
  ];

  for (const tier of tiers) {
    if (!tier.dir) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(tier.dir, { withFileTypes: true });
    } catch (e: any) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      let skillFilePath: string | null = null;
      let defaultName: string = entry.name;

      if (entry.isDirectory()) {
        const candidate = path.join(tier.dir, entry.name, "SKILL.md");
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          skillFilePath = candidate;
          defaultName = entry.name;
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        skillFilePath = path.join(tier.dir, entry.name);
        defaultName = path.basename(entry.name, ".md");
      }

      if (!skillFilePath) {
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(skillFilePath, "utf8");
      } catch (e: any) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
        continue;
      }

      const { frontmatter } = parseFrontmatter(content);
      const name =
        (typeof frontmatter?.name === "string" && frontmatter.name) || defaultName;
      const description =
        (typeof frontmatter?.description === "string" && frontmatter.description) || "";

      if (seen.has(name)) {
        continue;
      }
      seen.add(name);

      skills.push({
        name,
        description,
        path: path.resolve(skillFilePath),
        source: tier.source,
      });
    }
  }

  return { skills, errors };
}

export function formatSkillsForPlanner(skills: SkillSummary[]): string {
  return skills
    .map((s) => `- ${s.name}: ${s.description} (path: ${s.path})`)
    .join("\n");
}

export async function readSkillBody(skillPath: string): Promise<string> {
  const content = await fs.promises.readFile(skillPath, "utf8");
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}
