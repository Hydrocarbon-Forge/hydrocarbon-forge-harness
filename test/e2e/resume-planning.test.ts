import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R10.5: a resume after a stop during planning reuses a complete draft from the earlier session, and
// plans again (keeping the abandoned draft) when there is none that passes. The CLI is killed with
// SIGKILL while its fake planner is held open; the held planner is ended by its numeric pid.

const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");
const binDir = resolve(__dirname, "../../test/fixtures/fake-harness/bin");
const SEED = { "src/a.txt": "seed a\n", "contracts/types.ts": CONTRACT_STUB };
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku"];

type Ev = { type: string; data: any };
const children: ChildProcess[] = [];
const planners: number[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  }
  for (const pid of planners.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function waitFor(check: () => boolean, label: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const tick = () => {
      if (check()) return resolveWait();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function writeSettings(repoDir: string): void {
  mkdirSync(join(repoDir, ".substrate"), { recursive: true });
  writeFileSync(
    join(repoDir, ".substrate", "settings.json"),
    JSON.stringify({
      backends: {
        claude: { bin: join(binDir, "claude") },
        opencode: { bin: join(binDir, "opencode") },
        agy: { bin: join(binDir, "agy") },
      },
      concurrency: { workers: 1 },
    }),
    "utf8",
  );
}

function scenarioFile(calls: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "resume-planning-scenario-"));
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ calls }), "utf8");
  return file;
}

function homeDir(): string {
  return mkdtempSync(join(tmpdir(), "resume-planning-home-"));
}

function cliEnv(scenario: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir(), FAKE_SCENARIO_FILE: scenario };
  return env;
}

/** Starts the CLI and returns it; its output is collected in `out`. */
function startCli(repoDir: string, args: string[], scenario: string): { child: ChildProcess; out: { stdout: string; stderr: string } } {
  const child = spawn(process.execPath, [substrateMjs, ...args], { cwd: repoDir, env: cliEnv(scenario), stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const out = { stdout: "", stderr: "" };
  child.stdout?.on("data", (d) => (out.stdout += d));
  child.stderr?.on("data", (d) => (out.stderr += d));
  return { child, out };
}

/** Runs the CLI to its end, with the scripted calls for this round only. */
function cliSync(repoDir: string, args: string[], calls: unknown[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(process.execPath, [substrateMjs, ...args], {
    cwd: repoDir,
    encoding: "utf8",
    env: cliEnv(scenarioFile(calls)),
    timeout: 120000,
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

function runDirs(repoDir: string): string[] {
  const dir = join(repoDir, ".substrate", "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("r_"));
}

function eventsIn(runDir: string): Ev[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts a run whose planner is held open (the fake hangs and writes its pid); kills the CLI and the planner. */
async function killDuringPlanning(repoDir: string, scenario: string, calls: unknown[]): Promise<{ runId: string; plannerPid: number }> {
  writeFileSync(scenario, JSON.stringify({ calls }), "utf8");
  const pidFile = `${scenario}.pid`;
  const { child } = startCli(repoDir, [...RUN_ARGS, "Plan it"], scenario);
  await waitFor(() => existsSync(pidFile), "the held planner's pid");
  const plannerPid = Number(readFileSync(pidFile, "utf8"));
  planners.push(plannerPid);
  const runId = runDirs(repoDir)[0];
  // SIGKILL the CLI (our own child), then the held planner by its numeric pid.
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  process.kill(plannerPid, "SIGKILL");
  await waitFor(() => !alive(plannerPid), "the held planner to end");
  return { runId, plannerPid };
}

const edit = (task: string, file: string, marker: string) => ({
  task,
  edits: { [file]: `seed ${file.slice(-5, -4)}\n${marker}\n` },
  reply: `${task} done\nDONE`,
});

function oneTaskPlan(): Record<string, string> {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  return contractFiles(manifestFor("Resume planning", ["T1"]), { "tasks/T1.md": t1 });
}

describe("R10.5: a resume after a stop during planning", () => {
  it("(A) SIGKILL while the planner is held with no draft: resume plans again and the planner is called once more", async () => {
    const repo = createE2ERepo(SEED);
    writeSettings(repo.dir);
    try {
      const scenario = join(mkdtempSync(join(tmpdir(), "resume-planning-a-")), "scenario.json");
      const { runId } = await killDuringPlanning(repo.dir, scenario, [{ failure: "hang" }]);
      const runDir = join(repo.dir, ".substrate", "runs", runId);
      expect(eventsIn(runDir).filter((e) => e.type === "plan.started").length).toBe(1);

      const out = cliSync(repo.dir, ["resume", runId], [planCall(oneTaskPlan()), edit("T1", "src/a.txt", "t1-done")]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("no plan was accepted; planning again (planning costs again)");
      expect(out.stdout).not.toContain("found a complete plan draft");
      const events = eventsIn(runDir);
      expect(events.filter((e) => e.type === "plan.started").length).toBe(2);
      expect(events.some((e) => e.type === "run.finished" && e.data.exit_code === 0)).toBe(true);
    } finally {
      repo.cleanup();
    }
  }, 180000);

  it("(B) SIGKILL after a complete valid plan was written: resume uses the draft and does not call the planner", async () => {
    const repo = createE2ERepo(SEED);
    writeSettings(repo.dir);
    try {
      const scenario = join(mkdtempSync(join(tmpdir(), "resume-planning-b-")), "scenario.json");
      // The planner writes the whole plan, then hangs before it replies: no plan.produced is logged.
      const { runId } = await killDuringPlanning(repo.dir, scenario, [{ ...planCall(oneTaskPlan()), failure: "hang" }]);
      const runDir = join(repo.dir, ".substrate", "runs", runId);
      expect(existsSync(join(runDir, "manifest.yaml"))).toBe(true);
      expect(eventsIn(runDir).some((e) => e.type === "plan.produced")).toBe(false);

      // Only worker calls are scripted: a planner call would take an untagged slot and fail the run.
      const out = cliSync(repo.dir, ["resume", runId], [edit("T1", "src/a.txt", "t1-done")]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("found a complete plan draft from the earlier planning session; using it");
      const events = eventsIn(runDir);
      expect(events.filter((e) => e.type === "plan.started").length).toBe(1);
      const produced = events.find((e) => e.type === "plan.produced");
      expect(produced?.data.source).toBe("draft");
      expect(events.some((e) => e.type === "run.finished" && e.data.exit_code === 0)).toBe(true);
      expect(readFileSync(join(repo.dir, "src/a.txt"), "utf8")).toContain("t1-done");
    } finally {
      repo.cleanup();
    }
  }, 180000);

  it("(C) an incomplete draft (a spec the manifest names is missing) is set aside as drafts-1 and the run plans again", async () => {
    const repo = createE2ERepo(SEED);
    writeSettings(repo.dir);
    try {
      const scenario = join(mkdtempSync(join(tmpdir(), "resume-planning-c-")), "scenario.json");
      const incomplete = { "manifest.yaml": manifestFor("Resume planning", ["T1"]), "contracts/types.ts": CONTRACT_STUB };
      const { runId } = await killDuringPlanning(repo.dir, scenario, [{ ...planCall(incomplete), failure: "hang" }]);
      const runDir = join(repo.dir, ".substrate", "runs", runId);

      const out = cliSync(repo.dir, ["resume", runId], [planCall(oneTaskPlan()), edit("T1", "src/a.txt", "t1-done")]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("no plan was accepted; planning again (planning costs again)");
      expect(out.stdout).toContain("abandoned draft kept in drafts-1/");
      // Moved, not deleted: the abandoned manifest is in drafts-1.
      expect(existsSync(join(runDir, "drafts-1", "manifest.yaml"))).toBe(true);
      expect(eventsIn(runDir).filter((e) => e.type === "plan.started").length).toBe(2);
    } finally {
      repo.cleanup();
    }
  }, 180000);
});
