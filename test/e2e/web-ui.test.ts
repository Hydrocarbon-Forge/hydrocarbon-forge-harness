import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `substrate ui serve` as a child process on an OS-chosen port, with an isolated state and config dir. The
// project, its run and the registry are seeded in a temp directory; nothing calls a harness.

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "substrate.mjs");
const RUN_ID = "r_WEBUI00000001";
const T0 = "2026-10-22T10:00:00.000Z";

interface Ui {
  url: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill("SIGKILL");
});

/** Seeds a project with one finished run and a registry that lists it. Returns the env the CLI runs with. */
function seed(): { env: NodeJS.ProcessEnv; projectPath: string; runDir: string } {
  const base = mkdtempSync(join(tmpdir(), "substrate-web-e2e-"));
  const stateHome = join(base, "state");
  const configDir = join(base, "config");
  const projectPath = join(base, "project");
  const runDir = join(projectPath, ".substrate", "runs", RUN_ID);
  mkdirSync(join(runDir, "transcripts"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(stateHome, "substrate"), { recursive: true });
  const events = [
    { v: 1, seq: 1, ts: T0, run_id: RUN_ID, type: "run.created", data: { prompt: "make a snake game", base_branch: "main", requested_roles: { planner: { backend: "claude", model: "sonnet" }, worker: { backend: "claude", model: "haiku" } } } },
    { v: 1, seq: 2, ts: T0, run_id: RUN_ID, type: "run.finished", data: { exit_code: 0, status: "finished" } },
  ];
  writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(runDir, "result.json"), JSON.stringify({ merged: false, verification: "not_run", exit_code: 0 }));
  writeFileSync(
    join(stateHome, "substrate", "projects.json"),
    JSON.stringify({ version: 1, projects: [{ path: projectPath, name: "project", first_seen: T0, last_seen: T0 }] }),
  );
  const env = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    SUBSTRATE_CONFIG_DIR: configDir,
    SUBSTRATE_SETTINGS: "",
    SUBSTRATE_PROJECT_DIR: "",
  };
  return { env, projectPath, runDir };
}

/** Starts `ui serve` on an OS-chosen port and resolves with its URL (the first line it prints). */
function startUi(env: NodeJS.ProcessEnv): Promise<Ui> {
  // The server runs in an empty directory of its own: a project it finds in its working directory (the repository's own
  // .substrate, when run from the checkout) would be registered and change the seeded project count.
  const cwd = mkdtempSync(join(tmpdir(), "substrate-web-cwd-"));
  const child = spawn(process.execPath, [CLI, "ui", "serve", "--port", "0"], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  running.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const newline = out.indexOf("\n");
      if (newline < 0) return;
      resolve({
        url: out.slice(0, newline).trim(),
        child,
        stop: () =>
          new Promise<void>((done) => {
            child.once("exit", () => {
              rmSync(cwd, { recursive: true, force: true });
              done();
            });
            child.kill("SIGINT");
          }),
      });
    });
    child.once("exit", (code) => {
      rmSync(cwd, { recursive: true, force: true });
      reject(new Error(`ui serve exited with ${code} before printing its URL`));
    });
  });
}

function refOf(projectPath: string): string {
  // The project id is the first 12 hex characters of sha256 over the realpath (design 5.1).
  return `${createHash("sha256").update(projectPath).digest("hex").slice(0, 12)}~${RUN_ID}`;
}

describe("E2E web UI server (ui serve)", () => {
  it("answers /api/health and /api/projects for a seeded state dir, on an OS-chosen localhost port", async () => {
    const seeded = seed();
    const ui = await startUi(seeded.env);
    try {
      expect(ui.url).toMatch(/^http:\/\/localhost:\d+$/);
      const health = await fetch(`${ui.url}/api/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      const body = (await health.json()) as { ok: boolean; projects: number };
      expect(body.ok).toBe(true);
      expect(body.projects).toBe(1);

      const projects = (await (await fetch(`${ui.url}/api/projects`)).json()) as { name: string; running_count: number }[];
      expect(projects.map((p) => p.name)).toEqual(["project"]);
      expect(projects[0].running_count).toBe(0);
    } finally {
      await ui.stop();
    }
  });

  it("returns a seeded run's detail with its ref, status, models and sessions", async () => {
    const seeded = seed();
    const ui = await startUi(seeded.env);
    try {
      const ref = refOf(seeded.projectPath);
      const res = await fetch(`${ui.url}/api/runs/${encodeURIComponent(ref)}`);
      expect(res.status).toBe(200);
      const run = (await res.json()) as { ref: string; status: string; live: boolean; request: string; planner: { model: string }; worker: { model: string }; tasks: unknown[]; chat_available: boolean };
      expect(run.ref).toBe(ref);
      expect(run.status).toBe("finished");
      expect(run.live).toBe(false);
      expect(run.request).toBe("make a snake game");
      expect(run.planner.model).toBe("sonnet");
      expect(run.worker.model).toBe("haiku");
      expect(run.tasks).toEqual([]);
      expect(run.chat_available).toBe(true);

      const missing = await fetch(`${ui.url}/api/runs/${encodeURIComponent("nope~r_NOPE")}`);
      expect(missing.status).toBe(404);
    } finally {
      await ui.stop();
    }
  });

  it("streams a new engine event to an SSE client after a line is appended to events.jsonl", async () => {
    const seeded = seed();
    const ui = await startUi(seeded.env);
    const controller = new AbortController();
    try {
      const ref = refOf(seeded.projectPath);
      const res = await fetch(`${ui.url}/api/runs/${encodeURIComponent(ref)}/stream`, { signal: controller.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const readUntil = async (needle: string, ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (text.includes(needle)) return true;
          const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
          if (chunk && !chunk.done) text += decoder.decode(chunk.value, { stream: true });
        }
        return text.includes(needle);
      };

      expect(await readUntil('"seq":2', 5000)).toBe(true);
      const appended = { v: 1, seq: 3, ts: T0, run_id: RUN_ID, type: "run.message", data: { message_id: 1, kind: "chat", chat_id: "c1" } };
      appendFileSync(join(seeded.runDir, "events.jsonl"), JSON.stringify(appended) + "\n");
      expect(await readUntil('"seq":3', 5000)).toBe(true);
      expect(text).toContain("event: engine");
      expect(text).toContain('"type":"run.message"');
    } finally {
      controller.abort();
      await ui.stop();
    }
  });

  it("serves every asset the index page references with the content type its kind needs", async () => {
    const seeded = seed();
    const ui = await startUi(seeded.env);
    try {
      const page = await fetch(`${ui.url}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      const assets = [...html.matchAll(/(?:href|src)="(assets\/[^"]+)"/g)].map((m) => m[1]);
      expect(assets).toContain("assets/app.css");
      expect(assets).toContain("assets/js/app.js");
      for (const asset of assets) {
        const res = await fetch(`${ui.url}/${asset}`);
        expect(res.status, asset).toBe(200);
        const type = res.headers.get("content-type") ?? "";
        expect(type, asset).toMatch(asset.endsWith(".css") ? /^text\/css/ : /^text\/javascript/);
      }
    } finally {
      await ui.stop();
    }
  });

  it("keeps every client module a valid ES module (node --check on a .mjs copy of each file)", () => {
    const moduleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "web", "js");
    const copies = mkdtempSync(join(tmpdir(), "substrate-web-client-"));
    const files = readdirSync(moduleDir).filter((name) => name.endsWith(".js"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const copy = join(copies, name.replace(/\.js$/, ".mjs"));
      copyFileSync(join(moduleDir, name), copy);
      const result = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });
});
