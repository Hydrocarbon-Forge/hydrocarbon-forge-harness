import fs from "node:fs";
import path from "node:path";

import { xdgStateHome } from "../ledger/usage.js";
import { log } from "../util/log.js";

// The user-level registry of every project that has run Substrate on this machine (web-ui design, section 6.1):
// `$XDG_STATE_HOME/substrate/projects.json`. The CLI registers a project when it starts a run, plans, resumes or
// initialises. A project is listed only while its directory and its `.substrate` directory still exist.

export interface ProjectEntry {
  /** The project's absolute realpath. */
  path: string;
  /** The basename of the path. */
  name: string;
  first_seen: string;
  last_seen: string;
}

interface ProjectsFile {
  version: 1;
  projects: ProjectEntry[];
}

const FILE_NAME = "projects.json";
const USAGE_MIRROR_NAME = "usage.jsonl";

function stateDirOf(env: NodeJS.ProcessEnv): string {
  return path.join(xdgStateHome(env), "substrate");
}

/** Reads the registry. Undefined when the file does not exist; a corrupt file reads as an empty list (with a warning). */
function readProjects(file: string): ProjectEntry[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    log.warn(`project registry ${file} is not readable; treating it as empty`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
    if (!Array.isArray(parsed.projects)) throw new Error("no projects list");
    return parsed.projects.filter(
      (p): p is ProjectEntry =>
        typeof p?.path === "string" &&
        typeof p.name === "string" &&
        typeof p.first_seen === "string" &&
        typeof p.last_seen === "string",
    );
  } catch {
    log.warn(`project registry ${file} is corrupt; treating it as empty`);
    return [];
  }
}

/** Writes the registry atomically: a temporary file in the same directory, then a rename. */
function writeProjects(file: string, projects: ProjectEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data: ProjectsFile = { version: 1, projects };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * The projects the usage mirror names (each line carries its project path), for the one-time backfill of a registry
 * that did not exist yet. A project whose directory is gone is left out.
 */
function projectsFromUsage(usageFile: string): ProjectEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(usageFile, "utf8");
  } catch {
    return [];
  }
  const times = new Map<string, { first: string; last: string }>();
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: { project?: unknown; ts?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn line
    }
    if (typeof entry.project !== "string" || typeof entry.ts !== "string") continue;
    const seen = times.get(entry.project);
    if (seen === undefined) {
      times.set(entry.project, { first: entry.ts, last: entry.ts });
    } else {
      if (entry.ts < seen.first) seen.first = entry.ts;
      if (entry.ts > seen.last) seen.last = entry.ts;
    }
  }
  const byPath = new Map<string, ProjectEntry>();
  for (const [project, span] of times) {
    let real: string;
    try {
      real = fs.realpathSync(project);
    } catch {
      continue; // the directory no longer exists
    }
    const existing = byPath.get(real);
    if (existing === undefined) {
      byPath.set(real, { path: real, name: path.basename(real), first_seen: span.first, last_seen: span.last });
    } else {
      if (span.first < existing.first_seen) existing.first_seen = span.first;
      if (span.last > existing.last_seen) existing.last_seen = span.last;
    }
  }
  return [...byPath.values()];
}

/** The registry as it is on disk. A missing file is created once, backfilled from the usage mirror. */
function loadProjects(env: NodeJS.ProcessEnv): { file: string; projects: ProjectEntry[] } {
  const file = path.join(stateDirOf(env), FILE_NAME);
  const existing = readProjects(file);
  if (existing !== undefined) return { file, projects: existing };
  const backfilled = projectsFromUsage(path.join(stateDirOf(env), USAGE_MIRROR_NAME));
  try {
    writeProjects(file, backfilled);
  } catch (err: any) {
    log.warn(`could not write project registry ${file}: ${err?.message ?? String(err)}`);
  }
  return { file, projects: backfilled };
}

/**
 * Records a project in the registry: its realpath, its name, and the time it was last seen. Idempotent. Never throws:
 * a project that cannot be registered is a warning, and the run it belongs to goes on.
 */
export function registerProject(projectRoot: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
  try {
    const real = fs.realpathSync(projectRoot);
    const stamp = now.toISOString();
    const { file, projects } = loadProjects(env);
    const known = projects.find((p) => p.path === real);
    if (known !== undefined) {
      known.last_seen = stamp;
    } else {
      projects.push({ path: real, name: path.basename(real), first_seen: stamp, last_seen: stamp });
    }
    writeProjects(file, projects);
  } catch (err: any) {
    log.warn(`could not register project ${projectRoot}: ${err?.message ?? String(err)}`);
  }
}

/**
 * The projects that still exist: the registry without the entries whose directory or `.substrate` directory is gone.
 * The file is rewritten only when an entry was dropped.
 */
export function listProjects(env: NodeJS.ProcessEnv = process.env): ProjectEntry[] {
  const { file, projects } = loadProjects(env);
  const live = projects.filter(
    (p) => fs.existsSync(p.path) && fs.existsSync(path.join(p.path, ".substrate")),
  );
  if (live.length !== projects.length) {
    try {
      writeProjects(file, live);
    } catch (err: any) {
      log.warn(`could not write project registry ${file}: ${err?.message ?? String(err)}`);
    }
  }
  return live;
}
