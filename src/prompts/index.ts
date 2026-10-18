import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptRoots = {
  projectRoot?: string;
  userConfigDir?: string;
};

export type AgentRole = "planner" | "worker" | "test-writer" | "reviewer" | "governor";

const AGENT_ROLES: AgentRole[] = [
  "planner",
  "worker",
  "test-writer",
  "reviewer",
  "governor",
];

/**
 * The built-in assets directory, resolved relative to this module:
 * `here/assets` (dist/ in the bundle), `here/../assets`, or
 * `here/../../assets` (src/prompts in dev). A candidate counts when
 * it contains an `agents/` subdirectory. Never uses process.cwd().
 */
export function builtinRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "assets"),
    join(here, "..", "assets"),
    join(here, "..", "..", "assets"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && existsSync(join(candidate, "agents"))) {
      return candidate;
    }
  }
  throw new Error("built-in prompt assets not found");
}

function defaultUserConfigDir(): string {
  return (
    process.env.SUBSTRATE_CONFIG_DIR ??
    join(homedir(), ".config", "substrate")
  );
}

function resolveRoots(opts?: PromptRoots): Required<PromptRoots> {
  return {
    projectRoot: opts?.projectRoot ?? process.cwd(),
    userConfigDir: opts?.userConfigDir ?? defaultUserConfigDir(),
  };
}

/** Candidate file locations, first match wins. */
function agentCandidates(role: AgentRole, roots: Required<PromptRoots>): Array<{ source: "project" | "user" | "built-in"; path: string }> {
  return [
    { source: "project", path: join(roots.projectRoot, ".substrate", "agents", `${role}.md`) },
    { source: "user", path: join(roots.userConfigDir, "agents", `${role}.md`) },
    { source: "built-in", path: join(builtinRoot(), "agents", `${role}.md`) },
  ];
}

function templateCandidates(relPath: string, roots: Required<PromptRoots>): Array<{ source: "project" | "user" | "built-in"; path: string }> {
  return [
    { source: "project", path: join(roots.projectRoot, ".substrate", "prompts", relPath) },
    { source: "user", path: join(roots.userConfigDir, "prompts", relPath) },
    { source: "built-in", path: join(builtinRoot(), "prompts", relPath) },
  ];
}

function firstExisting(candidates: Array<{ source: "project" | "user" | "built-in"; path: string }>): { source: "project" | "user" | "built-in"; path: string } | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Strip a leading YAML frontmatter block: the file must start with `---\n`
 * and the block ends at the next line that is exactly `---`. Files
 * without frontmatter are returned unchanged.
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) {
    return text;
  }
  const rest = text.slice("---\n".length);
  const end = rest.indexOf("\n---\n");
  if (end === -1) {
    return text;
  }
  return rest.slice(end + "\n---\n".length);
}

/**
 * The body of `agents/<role>.md` with its YAML frontmatter removed and
 * the result trimmed, from the first existing candidate (project, user,
 * built-in).
 */
export function loadAgentBody(role: AgentRole, opts?: PromptRoots): string {
  const roots = resolveRoots(opts);
  const found = firstExisting(agentCandidates(role, roots));
  if (!found) {
    throw new Error(`no prompt asset for role "${role}": looked in .substrate/agents, user config, and built-in assets`);
  }
  const text = readFileSync(found.path, "utf8");
  return stripFrontmatter(normalizeLineEndings(text)).trim();
}

/**
 * The text of `prompts/<relPath>` from the first existing candidate
 * (project, user, built-in), with CRLF normalised. Not trimmed.
 */
export function loadTemplate(relPath: string, opts?: PromptRoots): string {
  const roots = resolveRoots(opts);
  const found = firstExisting(templateCandidates(relPath, roots));
  if (!found) {
    throw new Error(`no prompt template "${relPath}": looked in .substrate/prompts, user config, and built-in assets`);
  }
  return normalizeLineEndings(readFileSync(found.path, "utf8"));
}

/**
 * Whether a worker task-class addendum (`prompts/worker/class/<taskClass>.md`)
 * exists at any of the override roots, in override order.
 */
function hasTaskClassAddendum(taskClass: string, roots: Required<PromptRoots>): boolean {
  return firstExisting(templateCandidates(`worker/class/${taskClass}.md`, roots)) !== undefined;
}

/**
 * The assembled system prompt per role:
 * - planner:    agents/planner.md + prompts/planner/format.md
 * - worker:     agents/worker.md + prompts/worker/class/<taskClass>.md (if given and present)
 * - test-writer: agents/worker.md + agents/test-writer.md + prompts/worker/class/tests.md
 * - reviewer:   agents/reviewer.md
 * Parts are joined by a blank line.
 */
export function assembleSystem(
  role: Exclude<AgentRole, "governor">,
  opts: PromptRoots & { taskClass?: string },
): string {
  const roots = resolveRoots(opts);
  let parts: string[];
  switch (role) {
    case "planner":
      parts = [loadAgentBody("planner", opts), loadTemplate("planner/format.md", opts)];
      break;
    case "worker":
      parts = [loadAgentBody("worker", opts)];
      if (opts.taskClass && hasTaskClassAddendum(opts.taskClass, roots)) {
        parts.push(loadTemplate(`worker/class/${opts.taskClass}.md`, opts));
      }
      break;
    case "test-writer":
      parts = [
        loadAgentBody("worker", opts),
        loadAgentBody("test-writer", opts),
        loadTemplate("worker/class/tests.md", opts),
      ];
      break;
    case "reviewer":
      parts = [loadAgentBody("reviewer", opts)];
      break;
  }
  return parts.join("\n\n");
}

/**
 * One entry per agent role, in order, with the source of the first
 * existing candidate file. All five are always present.
 */
export function listAgents(opts?: PromptRoots): Array<{ role: string; source: "project" | "user" | "built-in"; path: string }> {
  const roots = resolveRoots(opts);
  return AGENT_ROLES.flatMap((role) => {
    const found = firstExisting(agentCandidates(role, roots));
    return found ? [{ role, source: found.source, path: resolve(found.path) }] : [];
  });
}
