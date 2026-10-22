import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { listProjects, registerProject } from "../../../src/store/projects.js";

// The project registry (web-ui design, section 6.1). Every test passes its own XDG_STATE_HOME, so nothing is
// written under the real home directory.

let root: string;
let stateHome: string;
let env: NodeJS.ProcessEnv;

function makeProject(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".substrate"), { recursive: true });
  return realpathSync(dir);
}

function registryFile(): string {
  return join(stateHome, "substrate", "projects.json");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "substrate-projects-"));
  stateHome = join(root, "state");
  env = { XDG_STATE_HOME: stateHome };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("project registry", () => {
  it("registers a project once, updates its last_seen on the next register, and keeps one entry", () => {
    const project = makeProject("alpha");
    registerProject(project, env, new Date("2026-10-01T10:00:00.000Z"));
    registerProject(project, env, new Date("2026-10-02T10:00:00.000Z"));

    const file = JSON.parse(readFileSync(registryFile(), "utf8"));
    expect(file.version).toBe(1);
    expect(file.projects).toEqual([
      {
        path: project,
        name: "alpha",
        first_seen: "2026-10-01T10:00:00.000Z",
        last_seen: "2026-10-02T10:00:00.000Z",
      },
    ]);
    expect(listProjects(env).map((p) => p.path)).toEqual([project]);
  });

  it("drops a project whose directory was deleted, and rewrites the file without it", () => {
    const kept = makeProject("kept");
    const gone = makeProject("gone");
    registerProject(kept, env);
    registerProject(gone, env);

    rmSync(gone, { recursive: true, force: true });

    expect(listProjects(env).map((p) => p.path)).toEqual([kept]);
    const file = JSON.parse(readFileSync(registryFile(), "utf8"));
    expect(file.projects.map((p: { path: string }) => p.path)).toEqual([kept]);
  });

  it("treats a corrupt registry as empty and rewrites it on the next register", () => {
    mkdirSync(join(stateHome, "substrate"), { recursive: true });
    writeFileSync(registryFile(), "{not json", "utf8");

    expect(listProjects(env)).toEqual([]);

    const project = makeProject("beta");
    registerProject(project, env);
    const file = JSON.parse(readFileSync(registryFile(), "utf8"));
    expect(file.projects.map((p: { path: string }) => p.path)).toEqual([project]);
  });

  it("backfills a missing registry once from the project paths in the usage mirror", () => {
    const old = makeProject("old-project");
    const missing = join(root, "removed-project");
    const mirror = [
      { v: 1, ts: "2026-09-01T09:00:00.000Z", project: old, run_id: "r_OLD1", backend: "claude", model: "m", cost_usd: 0 },
      { v: 1, ts: "2026-09-05T09:00:00.000Z", project: old, run_id: "r_OLD2", backend: "claude", model: "m", cost_usd: 0 },
      { v: 1, ts: "2026-09-02T09:00:00.000Z", project: missing, run_id: "r_GONE", backend: "claude", model: "m", cost_usd: 0 },
    ];
    mkdirSync(join(stateHome, "substrate"), { recursive: true });
    writeFileSync(join(stateHome, "substrate", "usage.jsonl"), mirror.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const listed = listProjects(env);
    expect(listed).toEqual([
      { path: old, name: basename(old), first_seen: "2026-09-01T09:00:00.000Z", last_seen: "2026-09-05T09:00:00.000Z" },
    ]);
    expect(JSON.parse(readFileSync(registryFile(), "utf8")).projects).toHaveLength(1);
  });
});
