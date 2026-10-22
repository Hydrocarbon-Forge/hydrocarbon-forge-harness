import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The artifacts of a run, as the web API names them (docs/design/web-ui.md, 5.1 ArtifactRef and 5.2). A client never
// supplies a path: the server lists the files of the run directory it serves, gives each one an opaque key (a
// hash of its run-relative path), and maps a key back to its file only through this list. A key that is not in the
// list is unknown (404), so no request can name a file outside what the run wrote.

export type ArtifactKind = "summary" | "verify_full" | "patch" | "spec" | "packet" | "report" | "progress_log" | "plan_file";

export interface ArtifactEntry {
  key: string;
  /** The file's path relative to the run directory. Internal: never sent to a client. */
  path: string;
  label: string;
  kind: ArtifactKind;
  bytes: number;
  contentType: string;
}

/** The public view of an artifact (ArtifactRef in the design). */
export interface ArtifactRef {
  key: string;
  label: string;
  kind: ArtifactKind;
  bytes: number;
}

const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json";
const MARKDOWN = "text/markdown; charset=utf-8";

/** The opaque key of a run-relative path: 24 hex characters of its sha256. */
export function artifactKeyOf(relPath: string): string {
  return createHash("sha256").update(relPath).digest("hex").slice(0, 24);
}

export function refOf(entry: ArtifactEntry): ArtifactRef {
  return { key: entry.key, label: entry.label, kind: entry.kind, bytes: entry.bytes };
}

function listed(dir: string, keep: (name: string) => boolean): string[] {
  try {
    return fs.readdirSync(dir).filter(keep).sort();
  } catch {
    return [];
  }
}

function sizeOf(file: string): number | undefined {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/** The label of a verify output file `<task>-g<n>-attempt<k>-<i>.out`, or undefined for another name. */
function verifyLabelOf(name: string): string | undefined {
  const m = /^(.+)-g(\d+)-attempt(\d+)-(\d+)\.(out|err)$/.exec(name);
  if (m === null) return undefined;
  return `${m[5] === "out" ? "verify output" : "verify stderr"}, task ${m[1]} g${m[2]} a${m[3]}, command ${Number(m[4]) + 1}`;
}

/** Every artifact the run directory holds, in a fixed order. Built from the directory listing each time it is asked for. */
export function artifactIndexOf(runDir: string): ArtifactEntry[] {
  const entries: ArtifactEntry[] = [];
  const add = (rel: string, label: string, kind: ArtifactKind, contentType: string): void => {
    const bytes = sizeOf(path.join(runDir, rel));
    if (bytes === undefined) return;
    entries.push({ key: artifactKeyOf(rel), path: rel, label, kind, bytes, contentType });
  };

  add("REPORT.md", "run report", "report", MARKDOWN);
  add("summary.txt", "run summary", "summary", TEXT);
  add("result.json", "run result", "report", JSON_TYPE);
  add("progress.log", "progress log", "progress_log", TEXT);
  add("manifest.yaml", "plan manifest", "plan_file", TEXT);
  add("decisions.md", "plan decisions", "plan_file", MARKDOWN);
  for (const name of listed(path.join(runDir, "tasks"), (n) => n.endsWith(".md"))) {
    add(path.join("tasks", name), `task spec ${name.replace(/\.md$/, "")}`, "spec", MARKDOWN);
  }

  const packets = path.join(runDir, "packets");
  for (const name of listed(packets, (n) => /-g\d+-attempt\d+\.json$/.test(n))) {
    add(path.join("packets", name), `attempt report ${name.replace(/\.json$/, "")}`, "packet", JSON_TYPE);
  }
  for (const name of listed(packets, (n) => n.endsWith(".patch"))) {
    add(path.join("packets", name), `patch, ${name.replace(/\.patch$/, "")}`, "patch", TEXT);
  }
  for (const name of listed(path.join(packets, "merged"), (n) => n.endsWith(".patch"))) {
    add(path.join("packets", "merged", name), `merged patch, ${name.replace(/\.patch$/, "")}`, "patch", TEXT);
  }
  for (const dir of [path.join(packets, "verify"), path.join(runDir, "integration")]) {
    const rel = path.relative(runDir, dir);
    for (const name of listed(dir, (n) => /\.(out|err)$/.test(n))) {
      const label = verifyLabelOf(name) ?? `verify output, ${name}`;
      add(path.join(rel, name), label, "verify_full", TEXT);
    }
  }
  return entries;
}

/** The entry of a key in the run's index, or undefined. */
export function artifactOfKey(runDir: string, key: string): ArtifactEntry | undefined {
  return artifactIndexOf(runDir).find((e) => e.key === key);
}

/** The key of a run-relative path, when the path is one the index lists (undefined otherwise). */
export function keyOfPath(index: readonly ArtifactEntry[], relPath: string | undefined): ArtifactRef | null {
  if (relPath === undefined) return null;
  const entry = index.find((e) => e.path === relPath.split(path.sep).join("/"));
  return entry === undefined ? null : refOf(entry);
}
